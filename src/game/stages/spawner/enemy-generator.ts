// 個々の敵機を、座標・色・機種などのパラメータから直接生成する。無秩序に漂う姿勢と
// プログレードへ向けた姿勢の2方針を並べて置く。
// **軌道は、置く位置で最も強く引く天体を中心とする二体の幾何で置く、ゲームバランスのための簡易な置き方。**
// 高度はその天体の表面半径の球面から測る(扁平な天体の基準楕円体とのずれ — 地球の極で 21km — は
// 出現高度の余裕に埋もれる)。
import * as THREE from 'three/webgpu';
import { qFromForwardUp, randomQuat, type Quat } from '../../../math/quat';
import { addPrimaryRelative, KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { strongestAttractor } from '../../../physics/attractor';
import { frameOfCelestialBody, toFrameState } from '../../../physics/frame';
import { stateFromOrbitalElements } from '../../../physics/elements';
import { randSym } from '../../../math/random';
import { addScaled, cross, len, norm, rotateAxis, scale, sub, v3, type Vec3 } from '../../../math/vec3';
import type { FlashEffects } from '../../vfx/flash-effects';
import { Enemy } from '../../dynamic/dynamic-entity/enemy';
import { MetalEnemy } from '../../dynamic/dynamic-entity/metal-enemy';
import { ProteinEnemy } from '../../dynamic/dynamic-entity/protein-enemy';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { EntityIdAllocators } from '../../dynamic/dynamic-entity/entity-id';
import type { FormationRole } from '../../dynamic/dynamic-entity/entity-kind';
import type { ProteinAssetId } from '../../protein/protein-asset-loader';
import type { ProteinDisplaySettings } from '../../../render/protein/protein-display';

// 自機軌道(base)を、中心天体 center まわりの軌道面内で弧長 dAlong [m] だけ進めた、center 相対の状態。
function phasedState(base: KinematicState, center: CelestialBody, dAlong: number): KinematicState<'primaryRel'> {
  const rel = toFrameState(frameOfCelestialBody(center, base.t), base);
  const hHat = norm(cross(rel.r, rel.v));
  const ang = dAlong / len(rel.r);
  return kinematicState<'primaryRel'>(base.t, rotateAxis(rel.r, hHat, ang), rotateAxis(rel.v, hHat, ang));
}

// 自由回転で漂う敵に共通の初期姿勢: ランダムな姿勢・角速度を与える。
function driftingAttitude(): { q: Quat; w: Vec3 } {
  return { q: randomQuat(), w: v3(randSym(0.12), randSym(0.12), randSym(0.12)) };
}

// state に、無秩序に漂う金属の敵を生成する。
export function generateDriftingEnemy(name: string, state: KinematicState, accent: string | number, orbitLineColor: string | number, fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators, attackGroupId?: string): Enemy {
  return new MetalEnemy(
    { name, state, ...driftingAttitude(), accent, orbitLineColor, attackGroupId, typeIndex: null },
    fx, idAllocators, scene,
  );
}

// 登録されたタンパク質アセットを、現在の表示設定で描画する敵。陣形に属する個体だけが
// formationId と役割を持ち、属さない個体は単体敵になる。
export function generateProteinEnemy(
  name: string, state: KinematicState, assetId: ProteinAssetId, display: ProteinDisplaySettings,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
  formationId?: string, formationRole?: FormationRole,
): Enemy {
  return new ProteinEnemy(
    {
      name, state, ...driftingAttitude(),
      accent: 0xffffff, orbitLineColor: 0xffffff, attackGroupId: formationId,
      assetId, display, formationId, formationRole,
    },
    fx, idAllocators, scene,
  );
}

// タンパク質陣形の 3 役(SPEC COMBAT.md「タンパク質陣形」節)を、共通の時刻・速度で組む。
// centerState を中心に、攻撃担当(5I4R)はその場、盾役(ルビスコ)はプレイヤー方向へ 450 m、
// エネルギー役(ATPシンテターゼ)は反対方向へ 450 m 離す。役ごとに準備完了を待てるよう
// (SPEC/PROTEIN.md「出現」節)、実体ではなく assetId と build の組を返す。
export function proteinFormationSpawns(
  name: string, centerState: KinematicState, playerPosition: Vec3, display: ProteinDisplaySettings, formationId: string,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
): readonly { assetId: ProteinAssetId; build: () => Enemy }[] {
  // 盾役はプレイヤー側、エネルギー役は反対側へずらした状態に置く
  const towardPlayer = norm(sub(playerPosition, centerState.r));
  const offset = 450;
  const shieldState = kinematicState<'eci'>(centerState.t, addScaled(centerState.r, towardPlayer, offset), centerState.v);
  const energyState = kinematicState<'eci'>(centerState.t, addScaled(centerState.r, towardPlayer, -offset), centerState.v);
  return [
    {
      assetId: 'pdb-5i4r',
      build: () => generateProteinEnemy(`${name}-ATTACKER`, centerState, 'pdb-5i4r', display, fx, scene, idAllocators, formationId, 'attacker'),
    },
    {
      assetId: 'pdb-8ruc-rubisco',
      build: () => generateProteinEnemy(`${name}-SHIELD`, shieldState, 'pdb-8ruc-rubisco', display, fx, scene, idAllocators, formationId, 'shield'),
    },
    {
      assetId: 'pdb-6n2y-atp-synthase',
      build: () => generateProteinEnemy(`${name}-ENERGY`, energyState, 'pdb-6n2y-atp-synthase', display, fx, scene, idAllocators, formationId, 'energy'),
    },
  ];
}

// base から dAlong だけ進んだ位置に漂う敵を生成する。
export function generatePhasedEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const state = addPrimaryRelative(center.stateAt(base.t), phasedState(base, center, dAlong));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, fx, scene, idAllocators);
}

// base から dAlong だけ進め、高度を altitudeOffset ぶんずらした円軌道上に敵を生成する。
export function generateCoellipticEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number, altitudeOffset: number,
  accent: string | number, orbitLineColor: string | number,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const phased = phasedState(base, center, dAlong);
  const radius = len(phased.r) + altitudeOffset;
  const rel = kinematicState<'primaryRel'>(
    base.t,
    scale(norm(phased.r), radius),
    scale(norm(phased.v), Math.sqrt(center.def.mu / radius)),
  );
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, fx, scene, idAllocators);
}

// base から dAlong だけ進め、軌道面をわずかに傾けた交差軌道上に敵を生成する。
export function generateCrossingEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const phased = phasedState(base, center, dAlong);
  const rel = kinematicState<'primaryRel'>(base.t, phased.r, rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180));
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, fx, scene, idAllocators);
}

// base から dAlong だけ進め、速度を増して離心軌道上に敵を生成する。
export function generateEllipticEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], dAlong: number,
  accent: string | number, orbitLineColor: string | number,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const phased = phasedState(base, center, dAlong);
  const rel = kinematicState<'primaryRel'>(base.t, phased.r, scale(phased.v, 1.006));
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, fx, scene, idAllocators);
}

// base の位置で最も強く引く天体を回る、base と無関係な軌道要素から作るモルニヤ軌道の敵。
// 生成時刻(state のエポック)は base.t。
export function generateMolniyaEnemy(
  name: string, base: KinematicState, attractors: readonly CelestialBody[], raan: number, nu: number,
  accent: string | number, orbitLineColor: string | number,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
): Enemy {
  const center = strongestAttractor(base.r, attractors, base.t);
  const rp = center.def.radius + 1200e3;
  const ra = center.def.radius + 39400e3;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const orbit = stateFromOrbitalElements(base.t, a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu, center.def.mu);
  const rel = kinematicState<'primaryRel'>(base.t, orbit.r, orbit.v);
  return generateDriftingEnemy(name, addPrimaryRelative(center.stateAt(base.t), rel), accent, orbitLineColor, fx, scene, idAllocators);
}

// 機首を中心天体(state の位置で最も強く引く天体)に対するプログレードへ向け、回転していない
// 金属の敵を state に生成する。
export function generateApproachingEnemy(
  name: string, state: KinematicState, attractors: readonly CelestialBody[], accent: number, orbitLineColor: number,
  typeIndex: number, waveId: number | undefined,
  fx: FlashEffects, scene: THREE.Scene, idAllocators: EntityIdAllocators,
  attackGroupId?: string,
): Enemy {
  const center = strongestAttractor(state.r, attractors, state.t);
  const rel = toFrameState(frameOfCelestialBody(center, state.t), state);
  return new MetalEnemy(
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
      typeIndex,
    },
    fx,
    idAllocators,
    scene,
  );
}
