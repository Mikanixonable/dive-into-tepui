// 個々の敵機を、座標・色・機種などのパラメータから直接生成する。無秩序に漂う姿勢と
// プログレードへ向けた姿勢の2方針を並べて置く。
// **軌道は、置く位置で最も強く引く天体を中心とする二体の幾何で置く、ゲームバランスのための簡易な置き方。**
// 高度はその天体の表面半径の球面から測る(扁平な天体の基準楕円体とのずれ — 地球の極で 21km — は
// 出現高度の余裕に埋もれる)。
import { qFromForwardUp, randomQuat } from '../../../math/quat';
import { addPrimaryRelative, kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import { strongestAttractor } from '../../../physics/attractor';
import { frameOfCelestialBody, toFrameState } from '../../../physics/frame';
import { stateFromOrbitalElements } from '../../../physics/elements';
import { addScaled, cross, len, norm, rotateAxis, scale, sub, v3, type Vec3 } from '../../../math/vec3';
import { driftingAttitude, type Enemy } from '../../dynamic/dynamic-entity/enemy';
import { MetalEnemy } from '../../dynamic/dynamic-entity/metal-enemy';
import type * as THREE from 'three/webgpu';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { EntityIdAllocators } from '../../dynamic/dynamic-entity/entity-id';
import type { ProteinEnemyRequest } from '../../dynamic/dynamic-entity/protein-enemy';

// 自機軌道(base)を、中心天体 center まわりの軌道面内で弧長 dAlong [m] だけ進めた、center 相対の状態。
function phasedState(base: KinematicState, center: CelestialBody, dAlong: number): KinematicState<'primaryRel'> {
  const rel = toFrameState(frameOfCelestialBody(center, base.t), base);
  const hHat = norm(cross(rel.r, rel.v));
  const ang = dAlong / len(rel.r);
  return kinematicState<'primaryRel'>(base.t, rotateAxis(rel.r, hHat, ang), rotateAxis(rel.v, hHat, ang));
}

// state に、無秩序に漂う金属の敵を生成する。
export function generateDriftingEnemy(
  name: string, state: KinematicState, accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators, attackGroupId?: string,
): Enemy {
  return MetalEnemy.create(
    {
      name, state, ...driftingAttitude(), accent, orbitLineColor, attackGroupId,
      waveId: null, formationId: null, formationRole: null, typeIndex: null,
    },
    idAllocators, scene,
  );
}

// タンパク質陣形の 3 役(SPEC COMBAT.md「タンパク質陣形」節)の要求を、共通の時刻・速度で組む。
// centerState を中心に、攻撃担当(5I4R)はその場、盾役(ルビスコ)はプレイヤー方向へ 450 m、
// エネルギー役(ATPシンテターゼ)は反対方向へ 450 m 離す。
export function proteinFormationRequests(
  name: string, centerState: KinematicState, playerPosition: Vec3, formationId: string,
): readonly ProteinEnemyRequest[] {
  // 盾役はプレイヤー側、エネルギー役は反対側へずらした状態に置く
  const towardPlayer = norm(sub(playerPosition, centerState.r));
  const offset = 450;
  const shieldState = kinematicState<'eci'>(centerState.t, addScaled(centerState.r, towardPlayer, offset), centerState.v);
  const energyState = kinematicState<'eci'>(centerState.t, addScaled(centerState.r, towardPlayer, -offset), centerState.v);
  return [
    {
      name: `${name}-ATTACKER`, state: centerState, assetId: 'pdb-5i4r',
      formationId, formationRole: 'attacker',
    },
    {
      name: `${name}-SHIELD`, state: shieldState, assetId: 'pdb-8ruc-rubisco',
      formationId, formationRole: 'shield',
    },
    {
      name: `${name}-ENERGY`, state: energyState, assetId: 'pdb-6n2y-atp-synthase',
      formationId, formationRole: 'energy',
    },
  ];
}

// base から dAlong だけ進んだ位置に漂う敵を生成する。
export function generatePhasedEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const state = addPrimaryRelative(center.stateAt(base.t), phasedState(base, center, dAlong));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, scene, idAllocators);
}

// base から dAlong だけ進め、高度を altitudeOffset ぶんずらした円軌道上に敵を生成する。
export function generateCoellipticEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number, altitudeOffset: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const phased = phasedState(base, center, dAlong);
  const radius = len(phased.r) + altitudeOffset;
  const rel = kinematicState<'primaryRel'>(
    base.t,
    scale(norm(phased.r), radius),
    scale(norm(phased.v), Math.sqrt(center.def.mu / radius)),
  );
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// base から dAlong だけ進め、軌道面をわずかに傾けた交差軌道上に敵を生成する。
export function generateCrossingEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const phased = phasedState(base, center, dAlong);
  const rel = kinematicState<'primaryRel'>(base.t, phased.r, rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180));
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// base から dAlong だけ進め、速度を増して離心軌道上に敵を生成する。
export function generateEllipticEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const phased = phasedState(base, center, dAlong);
  const rel = kinematicState<'primaryRel'>(base.t, phased.r, scale(phased.v, 1.006));
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// base の位置で最も強く引く天体を回る、base と無関係な軌道要素から作るモルニヤ軌道の敵。
// 生成時刻(state のエポック)は base.t。
export function generateMolniyaEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], raan: number, nu: number,
  accent: string | number, orbitLineColor: string | number,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const rp = center.def.radius + 1200e3;
  const ra = center.def.radius + 39400e3;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const orbit = stateFromOrbitalElements(base.t, a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu, center.def.mu);
  const rel = kinematicState<'primaryRel'>(base.t, orbit.r, orbit.v);
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, scene, idAllocators);
}

// 機首を中心天体(state の位置で最も強く引く天体)に対するプログレードへ向け、回転していない
// 金属の敵を state に生成する。
export function generateApproachingEnemy(
  name: string, state: KinematicState, attractors: readonly CelestialBody[], accent: number, orbitLineColor: number,
  typeIndex: number, waveId: number | null,
  scene: THREE.Scene, idAllocators: EntityIdAllocators,
  attackGroupId?: string,
): Enemy {
  const center = strongestAttractor(state.r, attractors, state.t);
  const rel = toFrameState(frameOfCelestialBody(center, state.t), state);
  return MetalEnemy.create(
    {
      name,
      state,
      // 機首を中心天体に対するプログレードへ、上を中心天体の反対側へ向ける
      q: qFromForwardUp(rel.v, rel.r) ?? randomQuat(),
      w: v3(0, 0, 0),
      accent,
      orbitLineColor,
      attackGroupId,
      waveId,
      formationId: null,
      formationRole: null,
      typeIndex,
    },
    idAllocators,
    scene,
  );
}
