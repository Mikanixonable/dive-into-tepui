// 赤道面・黄道面の目安グリッド(緯線・経線)と両極マーカー。頂点は ECI に固定した
// 単位球面上の点(星殻と同じ半径)で、自機中心に追従する固定半径殻として描く。
import * as THREE from 'three/webgpu';
import { Q_ECL_TO_ECI } from '../physics/ephemeris';
import { qRotate } from '../physics/attitude';
import { Vec3, v3 } from '../physics/vec3';
import { STAR_SHELL_RADIUS } from './stars';
import { CameraSystem } from '../game/camera/camera-system';

export interface CelestialGridVisibility {
  readonly eclipticPlane: boolean;
  readonly eclipticPole: boolean;
  readonly eclipticGrid: boolean;
  readonly equatorPlane: boolean;
  readonly equatorPole: boolean;
  readonly equatorGrid: boolean;
}

// 面を張る直交基底。e1/e2 が面内、pole が法線(北極方向)。
interface PlaneBasis {
  readonly e1: Vec3;
  readonly e2: Vec3;
  readonly pole: Vec3;
}

// 赤道面はゲーム ECI そのもの(Y軸 = 北極)。
const EQUATOR_BASIS: PlaneBasis = { e1: v3(1, 0, 0), e2: v3(0, 0, 1), pole: v3(0, 1, 0) };
// 黄道面は Q_ECL_TO_ECI で赤道基底から回転させて得る(傾斜角を直書きしない)。
const ECLIPTIC_BASIS: PlaneBasis = {
  e1: qRotate(Q_ECL_TO_ECI, v3(1, 0, 0)),
  e2: qRotate(Q_ECL_TO_ECI, v3(0, 1, 0)),
  pole: qRotate(Q_ECL_TO_ECI, v3(0, 0, 1)),
};

const GRID_LAT_STEP_DEG = 30; // 緯線の間隔(赤道面自体を除く)
const GRID_LON_STEP_DEG = 30; // 経線の間隔
const CIRCLE_SEGMENTS = 64; // 円1本あたりの分割数
const POLE_MARKER_HALF_LEN = STAR_SHELL_RADIUS * 0.04; // 極マーカーの殻面からの突き出し長さ

function planePoint(basis: PlaneBasis, radius: number, latRad: number, lonRad: number): Vec3 {
  const c = radius * Math.cos(latRad);
  const s = radius * Math.sin(latRad);
  const cl = Math.cos(lonRad);
  const sl = Math.sin(lonRad);
  return v3(
    c * cl * basis.e1.x + c * sl * basis.e2.x + s * basis.pole.x,
    c * cl * basis.e1.y + c * sl * basis.e2.y + s * basis.pole.y,
    c * cl * basis.e1.z + c * sl * basis.e2.z + s * basis.pole.z,
  );
}

function makeLine(color: number, opacity: number): THREE.Line {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  line.renderOrder = 0;
  return line;
}

function setLinePoints(line: THREE.Line, points: readonly Vec3[]): void {
  const arr = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    arr[i * 3] = p.x;
    arr[i * 3 + 1] = p.y;
    arr[i * 3 + 2] = p.z;
  }
  line.geometry.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  line.geometry = geo;
}

// 緯度 latRad の円周を、始点を終端に複製して閉じた頂点列として返す
// (WebGPU レンダラーは THREE.LineLoop 非対応のため、THREE.Line で手動に閉じる)。
function circlePoints(basis: PlaneBasis, radius: number, latRad: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const lon = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    pts.push(planePoint(basis, radius, latRad, lon));
  }
  return pts;
}

function meridianPoints(basis: PlaneBasis, radius: number, lonRad: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const lat = -Math.PI / 2 + (i / CIRCLE_SEGMENTS) * Math.PI;
    pts.push(planePoint(basis, radius, lat, lonRad));
  }
  return pts;
}

// 面 1 枚ぶんの表示物: 基準円(plane)・緯線経線の網(grid)・両極マーカー(pole)。
// 3 種とも独立した可視トグルを持つため、束ねずに別オブジェクトとして保持する。
class GridPlane {
  readonly planeLine: THREE.Line;
  readonly gridGroup = new THREE.Group();
  readonly poleGroup = new THREE.Group();

  constructor(scene: THREE.Scene, basis: PlaneBasis, color: number) {
    this.planeLine = makeLine(color, 0.35);
    setLinePoints(this.planeLine, circlePoints(basis, STAR_SHELL_RADIUS, 0));
    scene.add(this.planeLine);

    for (let lat = -90 + GRID_LAT_STEP_DEG; lat < 90; lat += GRID_LAT_STEP_DEG) {
      if (lat === 0) continue;
      const line = makeLine(color, 0.18);
      setLinePoints(line, circlePoints(basis, STAR_SHELL_RADIUS, (lat * Math.PI) / 180));
      this.gridGroup.add(line);
    }
    for (let lon = 0; lon < 360; lon += GRID_LON_STEP_DEG) {
      const line = makeLine(color, 0.18);
      setLinePoints(line, meridianPoints(basis, STAR_SHELL_RADIUS, (lon * Math.PI) / 180));
      this.gridGroup.add(line);
    }
    scene.add(this.gridGroup);

    for (const sign of [1, -1]) {
      const tip = v3(basis.pole.x * STAR_SHELL_RADIUS * sign, basis.pole.y * STAR_SHELL_RADIUS * sign, basis.pole.z * STAR_SHELL_RADIUS * sign);
      const base = v3(
        tip.x - basis.pole.x * POLE_MARKER_HALF_LEN * sign,
        tip.y - basis.pole.y * POLE_MARKER_HALF_LEN * sign,
        tip.z - basis.pole.z * POLE_MARKER_HALF_LEN * sign,
      );
      const line = makeLine(color, 0.7);
      setLinePoints(line, [base, tip]);
      this.poleGroup.add(line);
    }
    scene.add(this.poleGroup);
  }

  sync(planeVisible: boolean, poleVisible: boolean, gridVisible: boolean, origin: THREE.Vector3, scale: number): void {
    this.planeLine.visible = planeVisible;
    this.gridGroup.visible = gridVisible;
    this.poleGroup.visible = poleVisible;
    for (const obj of [this.planeLine, this.gridGroup, this.poleGroup]) {
      obj.position.copy(origin);
      obj.scale.setScalar(scale);
    }
  }
}

export class CelestialGrid {
  private readonly equator: GridPlane;
  private readonly ecliptic: GridPlane;

  constructor(scene: THREE.Scene) {
    this.equator = new GridPlane(scene, EQUATOR_BASIS, 0x8b93a0);
    this.ecliptic = new GridPlane(scene, ECLIPTIC_BASIS, 0xc0a878);
  }

  // 星殻と同じくカメラ追従の固定半径殻として、6 トグルぶんの可視状態を反映する。
  sync(visibility: CelestialGridVisibility, cameraSystem: CameraSystem): void {
    const cam = cameraSystem.activeCamera;
    const scale = cameraSystem.overviewMode
      ? (cameraSystem.overviewCamera.camera.far * 0.9) / STAR_SHELL_RADIUS
      : 1.0;
    this.equator.sync(visibility.equatorPlane, visibility.equatorPole, visibility.equatorGrid, cam.position, scale);
    this.ecliptic.sync(visibility.eclipticPlane, visibility.eclipticPole, visibility.eclipticGrid, cam.position, scale);
  }
}
