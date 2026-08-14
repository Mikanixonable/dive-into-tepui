// 3D 空間に浮かぶ方眼紙状の参照グリッド。天球上の経緯線とは異なり、フォーカス位置を
// 通る固定平面として描く。面の向きだけを黄道面・赤道面・月軌道面から選べる。
import * as THREE from 'three/webgpu';
import { Q_ECL_TO_ECI } from '../physics/ecliptic';
import { FloatingOrigin } from '../game/floating-origin';
import { Vec3 } from '../physics/vec3';

export const SPATIAL_GRID_SPACING = 1e8; // 100,000 km [m]

interface PlaneBasis {
  readonly e1: THREE.Vector3;
  readonly e2: THREE.Vector3;
  readonly pole: THREE.Vector3;
}

function planeBasisFromPole(poleInput: THREE.Vector3): PlaneBasis {
  const pole = poleInput.clone().normalize();
  const reference = new THREE.Vector3(1, 0, 0);
  const e1 = reference.sub(pole.clone().multiplyScalar(reference.dot(pole)));
  if (e1.lengthSq() < 1e-8) e1.set(0, 0, 1).sub(pole.clone().multiplyScalar(pole.z));
  e1.normalize();
  const e2 = e1.clone().cross(pole).normalize();
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

const MIN_HALF_EXTENT = SPATIAL_GRID_SPACING * 10;
const MAX_HALF_EXTENT = SPATIAL_GRID_SPACING * 10000;
const EXTENT_BUCKET = SPATIAL_GRID_SPACING * 20;

function makeLine(color: number): THREE.LineSegments {
  const line = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  line.frustumCulled = false;
  line.renderOrder = 0;
  return line;
}

function gridPoints(basis: PlaneBasis, halfExtent: number): Float32Array {
  const count = Math.floor((halfExtent * 2) / SPATIAL_GRID_SPACING);
  const lineCount = count + 1;
  const values = new Float32Array(lineCount * 2 * 2 * 3);
  let offset = 0;
  const write = (u1: number, v1: number, u2: number, v2: number): void => {
    const p1x = basis.e1.x * u1 + basis.e2.x * v1;
    const p1y = basis.e1.y * u1 + basis.e2.y * v1;
    const p1z = basis.e1.z * u1 + basis.e2.z * v1;
    const p2x = basis.e1.x * u2 + basis.e2.x * v2;
    const p2y = basis.e1.y * u2 + basis.e2.y * v2;
    const p2z = basis.e1.z * u2 + basis.e2.z * v2;
    values[offset++] = p1x; values[offset++] = p1y; values[offset++] = p1z;
    values[offset++] = p2x; values[offset++] = p2y; values[offset++] = p2z;
  };
  for (let i = 0; i <= count; i++) {
    const coordinate = -halfExtent + i * SPATIAL_GRID_SPACING;
    write(-halfExtent, coordinate, halfExtent, coordinate);
    write(coordinate, -halfExtent, coordinate, halfExtent);
  }
  return values;
}

class SpatialGridPlane {
  private readonly line: THREE.LineSegments;
  private readonly initialBasis: PlaneBasis;
  private basis: PlaneBasis;
  private basisRotation = new THREE.Quaternion();
  private halfExtent = 0;

  public constructor(scene: THREE.Scene, basis: PlaneBasis, color: number) {
    this.initialBasis = basis;
    this.basis = basis;
    this.line = makeLine(color);
    scene.add(this.line);
    this.setBasis(basis);
  }

  public setBasis(basis: PlaneBasis): void {
    if (this.basis.pole.dot(basis.pole) > 1 - 1e-10 && this.basis.e1.dot(basis.e1) > 1 - 1e-10) return;
    this.basis = basis;
    const initialRotation = new THREE.Matrix4().makeBasis(
      this.initialBasis.e1, this.initialBasis.e2, this.initialBasis.pole,
    );
    const targetRotation = new THREE.Matrix4().makeBasis(basis.e1, basis.e2, basis.pole);
    const initialQ = new THREE.Quaternion().setFromRotationMatrix(initialRotation);
    const targetQ = new THREE.Quaternion().setFromRotationMatrix(targetRotation);
    this.basisRotation.copy(targetQ).multiply(initialQ.invert());
    this.line.quaternion.copy(this.basisRotation);
  }

  public sync(visible: boolean, basis: PlaneBasis, origin: Vec3, floatingOrigin: FloatingOrigin, cameraDistance: number): void {
    this.setBasis(basis);
    const halfExtent = Math.max(
      MIN_HALF_EXTENT,
      Math.min(MAX_HALF_EXTENT, Math.ceil((cameraDistance * 1.25) / EXTENT_BUCKET) * EXTENT_BUCKET),
    );
    if (halfExtent !== this.halfExtent) {
      this.halfExtent = halfExtent;
      const positions = gridPoints(this.initialBasis, halfExtent);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      this.line.geometry.dispose();
      this.line.geometry = geometry;
    }
    this.line.position.copy(floatingOrigin.RtoThreeV3(origin));
    this.line.visible = visible;
  }
}

export class SpatialGrid {
  private readonly ecliptic: SpatialGridPlane;
  private readonly equator: SpatialGridPlane;
  private readonly moonOrbit: SpatialGridPlane;

  public constructor(scene: THREE.Scene) {
    this.ecliptic = new SpatialGridPlane(scene, ECLIPTIC_BASIS, 0xc0a878);
    this.equator = new SpatialGridPlane(scene, EQUATOR_BASIS, 0x8b93a0);
    this.moonOrbit = new SpatialGridPlane(scene, ECLIPTIC_BASIS, 0x9b86b8);
  }

  public sync(
    visible: boolean, ecliptic: boolean, equator: boolean, moonOrbit: boolean,
    moonOrbitNormal: THREE.Vector3 | undefined, origin: Vec3, floatingOrigin: FloatingOrigin,
    cameraDistance: number,
  ): void {
    const moonBasis = moonOrbitNormal === undefined ? ECLIPTIC_BASIS : planeBasisFromPole(moonOrbitNormal);
    this.ecliptic.sync(visible && ecliptic, ECLIPTIC_BASIS, origin, floatingOrigin, cameraDistance);
    this.equator.sync(visible && equator, EQUATOR_BASIS, origin, floatingOrigin, cameraDistance);
    this.moonOrbit.sync(visible && moonOrbit, moonBasis, origin, floatingOrigin, cameraDistance);
  }
}
