// 空間に浮かぶ十字マーカー状の縮尺グリッド。天球グリッド(celestial-grid.ts)の経緯線とは
// 異なり、呼び出し側が与えた1点を通る固定平面として描く。黄道面・赤道面は向きが固定で、
// 月軌道面・月赤道面は毎フレーム法線を受け取る。
import * as THREE from 'three/webgpu';
import { Q_ECL_TO_ECI } from '../physics/ecliptic';
import { markOverlay } from './pipeline/lit-layer';

// 4面ぶんの表示可否。
export interface ScaleGridVisibility {
  readonly ecliptic: boolean;
  readonly equator: boolean;
  readonly moonOrbit: boolean;
  readonly moonEquator: boolean;
}

// 面を張る直交基底。e1/e2 が面内、pole が法線。
interface PlaneBasis {
  readonly e1: THREE.Vector3;
  readonly e2: THREE.Vector3;
  readonly pole: THREE.Vector3;
}

interface GridLevel {
  readonly spacing: number;
  readonly line: THREE.LineSegments;
  readonly material: THREE.LineBasicMaterial;
}

function planeBasisFromPole(poleInput: THREE.Vector3): PlaneBasis {
  const pole = poleInput.clone().normalize();
  const reference = new THREE.Vector3(1, 0, 0);
  const e1 = reference.sub(pole.clone().multiplyScalar(reference.dot(pole)));
  if (e1.lengthSq() < 1e-8) e1.set(0, 0, 1).sub(pole.clone().multiplyScalar(pole.z));
  e1.normalize();
  // e1×e2=pole の右手系にする(makeBasis→setFromRotationMatrix は回転行列しか四元数化できない)。
  const e2 = pole.clone().cross(e1).normalize();
  return { e1, e2, pole };
}

const eclToEciQuat = new THREE.Quaternion(Q_ECL_TO_ECI.x, Q_ECL_TO_ECI.y, Q_ECL_TO_ECI.z, Q_ECL_TO_ECI.w);

function rotatedAxis(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).applyQuaternion(eclToEciQuat);
}

const EQUATOR_BASIS: PlaneBasis = planeBasisFromPole(new THREE.Vector3(0, 1, 0));
const ECLIPTIC_BASIS: PlaneBasis = {
  e1: rotatedAxis(1, 0, 0),
  e2: rotatedAxis(0, 1, 0),
  pole: rotatedAxis(0, 0, 1),
};

// 縮尺の基準となる目盛り間隔。これ以上の段はラベルを ⊞、これ未満は ＋ で表す。
const REFERENCE_SPACING = 1e8; // 100,000 km [m]

// 基準を中心に、ズーム段階に応じて前後の縮尺を重ねる。
const GRID_SPACINGS = [
  1e3, 1e4, 1e5, 1e6, 1e7, REFERENCE_SPACING,
  1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
] as const;
const GRID_CROSS_CELLS = 40;
const GRID_CROSS_HALF_LENGTH = 0.12;
const GRID_BASE_OPACITY = 0.3;
const GRID_FADE_IN_PX = 8;
const GRID_FULL_PX = 24;
const GRID_FULL_OUT_PX = 80;
const GRID_FADE_OUT_PX = 180;

function makeLine(color: number): { line: THREE.LineSegments; material: THREE.LineBasicMaterial } {
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  markOverlay(line);
  line.frustumCulled = false;
  line.renderOrder = 0;
  return { line, material };
}

function crossPoints(basis: PlaneBasis, spacing: number): Float32Array {
  const halfCross = spacing * GRID_CROSS_HALF_LENGTH;
  const count = GRID_CROSS_CELLS * 2 + 1;
  const values = new Float32Array(count * count * 4 * 3);
  let offset = 0;
  const write = (u1: number, v1: number, u2: number, v2: number): void => {
    values[offset++] = basis.e1.x * u1 + basis.e2.x * v1;
    values[offset++] = basis.e1.y * u1 + basis.e2.y * v1;
    values[offset++] = basis.e1.z * u1 + basis.e2.z * v1;
    values[offset++] = basis.e1.x * u2 + basis.e2.x * v2;
    values[offset++] = basis.e1.y * u2 + basis.e2.y * v2;
    values[offset++] = basis.e1.z * u2 + basis.e2.z * v2;
  };
  for (let x = -GRID_CROSS_CELLS; x <= GRID_CROSS_CELLS; x++) {
    for (let y = -GRID_CROSS_CELLS; y <= GRID_CROSS_CELLS; y++) {
      const u = x * spacing;
      const v = y * spacing;
      write(u - halfCross, v, u + halfCross, v);
      write(u, v - halfCross, u, v + halfCross);
    }
  }
  return values;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function spacingLabel(spacing: number): string {
  return `${(spacing / 1e3).toLocaleString('ja-JP')} km`;
}

class ScaleGridPlane {
  private readonly levels: readonly GridLevel[];
  private readonly initialBasis: PlaneBasis;
  private readonly label: HTMLDivElement;
  private basis: PlaneBasis;
  private basisRotation = new THREE.Quaternion();

  public constructor(scene: THREE.Scene, basis: PlaneBasis, color: number, name: string) {
    this.initialBasis = basis;
    this.basis = basis;
    this.levels = GRID_SPACINGS.map((spacing) => {
      const made = makeLine(color);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(crossPoints(basis, spacing), 3));
      made.line.geometry = geometry;
      scene.add(made.line);
      return { spacing, line: made.line, material: made.material };
    });
    this.label = document.createElement('div');
    this.label.className = 'scale-grid-label';
    Object.assign(this.label.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '8', display: 'none',
      color: `#${color.toString(16).padStart(6, '0')}`, opacity: '0.8',
      font: '10px monospace', textShadow: '0 0 4px #000', whiteSpace: 'nowrap',
    });
    this.label.textContent = name;
    document.body.appendChild(this.label);
  }

  private setBasis(basis: PlaneBasis): void {
    if (this.basis.pole.dot(basis.pole) > 1 - 1e-10 && this.basis.e1.dot(basis.e1) > 1 - 1e-10) return;
    this.basis = basis;
    const initialRotation = new THREE.Matrix4().makeBasis(
      this.initialBasis.e1, this.initialBasis.e2, this.initialBasis.pole,
    );
    const targetRotation = new THREE.Matrix4().makeBasis(basis.e1, basis.e2, basis.pole);
    const initialQ = new THREE.Quaternion().setFromRotationMatrix(initialRotation);
    const targetQ = new THREE.Quaternion().setFromRotationMatrix(targetRotation);
    this.basisRotation.copy(targetQ).multiply(initialQ.invert());
  }

  // origin は面が通る点(描画座標)。全ズーム段を重ねて描き、画面上の目盛り間隔が
  // 見やすい段ほど濃くする。ラベルは最も濃い段の縮尺だけを出す。
  public sync(
    visible: boolean, basis: PlaneBasis, origin: THREE.Vector3,
    camera: THREE.Camera, cameraDistance: number,
  ): void {
    this.setBasis(basis);
    const metersPerPixel = camera instanceof THREE.OrthographicCamera
      ? (camera.top - camera.bottom) / Math.max(1, window.innerHeight)
      : camera instanceof THREE.PerspectiveCamera
        ? 2 * cameraDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / Math.max(1, window.innerHeight)
        : cameraDistance / Math.max(1, window.innerHeight);
    let bestLevel: GridLevel | null = null;
    let bestOpacity = 0;
    for (const level of this.levels) {
      const pixels = level.spacing / Math.max(1e-9, metersPerPixel);
      const fadeIn = smoothstep(GRID_FADE_IN_PX, GRID_FULL_PX, pixels);
      const fadeOut = 1 - smoothstep(GRID_FULL_OUT_PX, GRID_FADE_OUT_PX, pixels);
      const opacity = GRID_BASE_OPACITY * fadeIn * fadeOut;
      level.material.opacity = opacity;
      level.line.visible = visible && opacity > 1e-4;
      level.line.position.copy(origin);
      level.line.quaternion.copy(this.basisRotation);
      if (opacity > bestOpacity) {
        bestOpacity = opacity;
        bestLevel = level;
      }
    }
    this.label.style.display = 'none';
    if (!visible || bestLevel === null) return;
    const labelOffset = bestLevel.spacing * 5;
    const projected = new THREE.Vector3(
      origin.x + (this.basis.e1.x + this.basis.e2.x) * labelOffset,
      origin.y + (this.basis.e1.y + this.basis.e2.y) * labelOffset,
      origin.z + (this.basis.e1.z + this.basis.e2.z) * labelOffset,
    ).project(camera);
    if (projected.z < -1 || projected.z > 1) return;
    const margin = 12;
    const x = Math.max(margin, Math.min(window.innerWidth - margin, (projected.x * 0.5 + 0.5) * window.innerWidth));
    const y = Math.max(margin, Math.min(window.innerHeight - margin, (-projected.y * 0.5 + 0.5) * window.innerHeight));
    this.label.style.left = `${x}px`;
    this.label.style.top = `${y}px`;
    this.label.textContent = `${bestLevel.spacing >= REFERENCE_SPACING ? '⊞' : '＋'} ${spacingLabel(bestLevel.spacing)}`;
    this.label.style.display = '';
  }

  // 全ズーム段の線を親から外して解放し、スケールラベルを document.body から外す。
  dispose(): void {
    for (const level of this.levels) {
      level.line.removeFromParent();
      level.line.geometry.dispose();
      level.material.dispose();
    }
    this.label.remove();
  }
}

export class ScaleGrid {
  private readonly ecliptic: ScaleGridPlane;
  private readonly equator: ScaleGridPlane;
  private readonly moonOrbit: ScaleGridPlane;
  private readonly moonEquator: ScaleGridPlane;

  public constructor(scene: THREE.Scene) {
    this.ecliptic = new ScaleGridPlane(scene, ECLIPTIC_BASIS, 0xc0a878, '黄道面');
    this.equator = new ScaleGridPlane(scene, EQUATOR_BASIS, 0x8b93a0, '赤道面');
    this.moonOrbit = new ScaleGridPlane(scene, ECLIPTIC_BASIS, 0x9b86b8, '月軌道面');
    this.moonEquator = new ScaleGridPlane(scene, ECLIPTIC_BASIS, 0x86b89b, '月赤道面');
  }

  // 4面ぶんの表示状態を反映する。origin は4面が共通して通る点(描画座標)。
  // moonOrbitNormal / moonSpinAxis は向きが得られないとき null で、その面は黄道面へ倒す。
  public sync(
    visibility: ScaleGridVisibility,
    moonOrbitNormal: THREE.Vector3 | null, moonSpinAxis: THREE.Vector3 | null,
    origin: THREE.Vector3, camera: THREE.Camera, cameraDistance: number,
  ): void {
    const moonOrbitBasis = moonOrbitNormal === null ? ECLIPTIC_BASIS : planeBasisFromPole(moonOrbitNormal);
    const moonEquatorBasis = moonSpinAxis === null ? ECLIPTIC_BASIS : planeBasisFromPole(moonSpinAxis);
    this.ecliptic.sync(visibility.ecliptic, ECLIPTIC_BASIS, origin, camera, cameraDistance);
    this.equator.sync(visibility.equator, EQUATOR_BASIS, origin, camera, cameraDistance);
    this.moonOrbit.sync(visibility.moonOrbit, moonOrbitBasis, origin, camera, cameraDistance);
    this.moonEquator.sync(visibility.moonEquator, moonEquatorBasis, origin, camera, cameraDistance);
  }

  // 4面ぶんの ScaleGridPlane を解放する。
  dispose(): void {
    this.ecliptic.dispose();
    this.equator.dispose();
    this.moonOrbit.dispose();
    this.moonEquator.dispose();
  }
}
