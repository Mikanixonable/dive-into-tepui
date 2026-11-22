// 個々の敵機を、座標・色・機種などのパラメータから直接組む。
// **軌道は、置く位置で最も強く引く天体を中心とする二体の幾何で置く、ゲームバランスのための簡易な置き方。**
// 高度はその天体の表面半径の球面から測る(扁平な天体の基準楕円体とのずれ — 地球の極で 21km — は
// 出現高度の余裕に埋もれる)。
import { addPrimaryRelative, kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { strongestAttractor } from '../../physics/attractor';
import { frameOfCelestialBody, toFrameState } from '../../physics/frame';
import { semiMajorEccentricityFromApsides, stateFromOrbitalElements } from '../../physics/elements';
import { cross, len, norm, rotateAxis, scale } from '../../math/vec3';
import type { Enemy } from '../dynamic/entity/enemy';
import type * as THREE from 'three/webgpu';
import type { CelestialBody } from '../../physics/celestial-body';
import type { EntityIdAllocators } from '../dynamic/entity/entity-id';
import { AssemblyEnemy } from '../dynamic/entity/assembly-enemy';

// 自機軌道(referenceState)を、中心天体 center まわりの軌道面内で弧長 dAlong [m] だけ進めた、center 相対の状態。
function phasedState(referenceState: KinematicState, center: CelestialBody, dAlong: number): KinematicState<'primaryRel'> {
  const rel = toFrameState(frameOfCelestialBody(center, referenceState.t), referenceState);
  const hHat = norm(cross(rel.r, rel.v));
  const ang = dAlong / len(rel.r);
  return kinematicState<'primaryRel'>(referenceState.t, rotateAxis(rel.r, hHat, ang), rotateAxis(rel.v, hHat, ang));
}

// 個体の形を決める乱数の種を引く。種は出た個体の形を決めるだけなので、呼ぶたびに新しい乱数でよい。
function randomShapeSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

// state に、不規則な姿勢と回転で漂う組み立て型の敵(SPEC/ASSEMBLY.md)を生成する。形は個体ごとに
// 新しく生成する。waveId はウェーブに属する敵の番号で、属さなければ null。
export function generateDriftingEnemy(
  name: string, state: KinematicState, accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators, attackGroupId?: string, waveId: number | null = null,
): Enemy {
  return AssemblyEnemy.create(
    {
      name, state, seed: randomShapeSeed(), accent, orbitLineColor, attackGroupId,
      waveId, formationId: null, formationRole: null,
    },
    idAllocators, scene,
  );
}

// referenceState から dAlong だけ進んだ位置に漂う敵を生成する。
export function generatePhasedEnemy(
  name: string, referenceState: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(referenceState.r, attractors, referenceState.t);
  const state = addPrimaryRelative(center.stateAt(referenceState.t), phasedState(referenceState, center, dAlong));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, scene, idAllocators);
}

// referenceState から dAlong だけ進め、高度を altitudeOffset ぶんずらした円軌道上に敵を生成する。
export function generateCoellipticEnemy(
  name: string, referenceState: KinematicState, attractors: readonly CelestialBody[], dAlong: number, altitudeOffset: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(referenceState.r, attractors, referenceState.t);
  const phased = phasedState(referenceState, center, dAlong);
  const radius = len(phased.r) + altitudeOffset;
  const rel = kinematicState<'primaryRel'>(
    referenceState.t,
    scale(norm(phased.r), radius),
    scale(norm(phased.v), Math.sqrt(center.def.mu / radius)),
  );
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(referenceState.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// referenceState から dAlong だけ進め、軌道面をわずかに傾けた交差軌道上に敵を生成する。
export function generateCrossingEnemy(
  name: string, referenceState: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(referenceState.r, attractors, referenceState.t);
  const phased = phasedState(referenceState, center, dAlong);
  const rel = kinematicState<'primaryRel'>(referenceState.t, phased.r, rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180));
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(referenceState.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// referenceState から dAlong だけ進め、速度を増して離心軌道上に敵を生成する。
export function generateEllipticEnemy(
  name: string, referenceState: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(referenceState.r, attractors, referenceState.t);
  const phased = phasedState(referenceState, center, dAlong);
  const rel = kinematicState<'primaryRel'>(referenceState.t, phased.r, scale(phased.v, 1.006));
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(referenceState.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// referenceState の位置で最も強く引く天体を回る、referenceState と無関係な軌道要素から作るモルニヤ軌道の敵。
// 生成時刻(state のエポック)は referenceState.t。
export function generateMolniyaEnemy(
  name: string, referenceState: KinematicState, attractors: readonly CelestialBody[], raan: number, nu: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(referenceState.r, attractors, referenceState.t);
  const rp = center.def.radius + 1200e3;
  const ra = center.def.radius + 39400e3;
  const { a, e } = semiMajorEccentricityFromApsides(rp, ra);
  const orbit = stateFromOrbitalElements(referenceState.t, a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu, center.def.mu);
  const rel = kinematicState<'primaryRel'>(referenceState.t, orbit.r, orbit.v);
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(referenceState.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// 接近してくる波の敵を state に生成する。ウェーブに属さなければ waveId は null。
export function generateApproachingEnemy(
  name: string, state: KinematicState, accent: number, orbitLineColor: number, waveId: number | null,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
  attackGroupId?: string,
): Enemy {
  return generateDriftingEnemy(name, state, accent, orbitLineColor, scene, idAllocators, attackGroupId, waveId);
}
