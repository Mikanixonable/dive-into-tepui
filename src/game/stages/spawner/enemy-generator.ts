// 個々の敵機を、座標・色・機種などのパラメータから直接生成する。無秩序に漂う姿勢と
// プログレードへ向けた姿勢の2方針を、見比べられるようこの1ファイルに並べて置く。
//
// **ここの軌道は「地球中心の ECI・平均半径の真球」を前提にした簡易な置き方である。** 高度は
// ECI 原点からの距離で測り、周回速度は MU_EARTH から出す。これはゲームバランスのための
// 配置であって物理量の測定ではないので、天体ごとの大気・基準楕円体(physics/atmosphere.ts)へは
// 寄せていない — 緯度による基準面のずれ(赤道 +7km / 極 -14km)は、出現高度に持たせた余裕に
// 埋もれる大きさに収まる。地球以外を主星とするステージで敵を出すなら、この前提ごと組み直す。
import * as THREE from 'three/webgpu';
import { qFromForwardUp, randomQuat, type Quat } from '../../../math/quat';
import { KinematicState, kinematicState, orbitAxes } from '../../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../celestial/solar-system/constants';
import { stateFromOrbitalElements } from '../../../physics/elements';
import { randSym } from '../../../math/random';
import { addScaled, len, norm, rotateAxis, scale, v3, type Vec3 } from '../../../math/vec3';
import { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../dynamic/dynamic-entity/enemy';
import { MetalEnemy } from '../../dynamic/dynamic-entity/metal-enemy';
import { ProteinEnemy } from '../../dynamic/dynamic-entity/protein-enemy';
import type { FormationRole } from '../../dynamic/dynamic-entity/enemy';
import type { ProteinAssetId } from '../../protein/protein-asset-loader';
import type { ProteinDisplaySettings } from '../../protein/protein-display';

// 自機軌道(base)を dAlong だけ進めた位置の軌道状態(プリセット配置の共通基盤)。
function phasedState(base: KinematicState, dAlong: number): KinematicState {
  const hHat = orbitAxes(base).nrm;
  const ang = dAlong / len(base.r);
  return kinematicState<'eci'>(base.t, rotateAxis(base.r, hHat, ang), rotateAxis(base.v, hHat, ang));
}

// 自由回転で漂う敵に共通の初期姿勢: ランダムな姿勢・角速度を与える。
function driftingAttitude(): { q: Quat; w: Vec3 } {
  return { q: randomQuat(), w: v3(randSym(0.12), randSym(0.12), randSym(0.12)) };
}

// 無秩序に漂う敵(訓練クラスタ・通常ステージのプリセット敵の生成本体)。
export function generateDriftingEnemy(name: string, state: KinematicState, accent: string | number, orbitLineColor: string | number, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  return new MetalEnemy(
    { name, state, ...driftingAttitude(), accent, orbitLineColor, typeIndex: null },
    worldSfx, fx, scene,
  );
}

// 登録されたタンパク質アセットを、現在の表示設定で描画する敵。陣形に属する個体だけが
// formationId と役割を持ち、属さない個体は単体敵になる。
export function generateProteinEnemy(
  name: string, state: KinematicState, assetId: ProteinAssetId, display: ProteinDisplaySettings,
  worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
  formationId?: string, formationRole?: FormationRole,
): Enemy {
  return new ProteinEnemy(
    {
      name, state, ...driftingAttitude(),
      accent: 0xffffff, orbitLineColor: 0xffffff,
      assetId, display, formationId, formationRole,
    },
    worldSfx, fx, scene,
  );
}

// タンパク質陣形の 3 役(SPEC COMBAT.md「タンパク質陣形」節)を、共通の時刻・速度で組む。
// centerState を中心に、攻撃担当(5I4R)はその場、盾役(ルビスコ)はプレイヤー方向へ 450 m、
// エネルギー役(ATPシンテターゼ)は反対方向へ 450 m 離す。役ごとに準備完了を待てるよう
// (SPEC/PROTEIN.md「出現」節)、実体ではなく assetId と build の組を返す。
export function proteinFormationSpawns(
  name: string, centerState: KinematicState, playerPosition: Vec3, display: ProteinDisplaySettings, formationId: string,
  worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
): readonly { assetId: ProteinAssetId; build: () => Enemy }[] {
  const towardPlayer = norm(v3(playerPosition.x - centerState.r.x, playerPosition.y - centerState.r.y, playerPosition.z - centerState.r.z));
  const offset = 450;
  const shieldState = kinematicState<'eci'>(centerState.t, addScaled(centerState.r, towardPlayer, offset), centerState.v);
  const energyState = kinematicState<'eci'>(centerState.t, addScaled(centerState.r, towardPlayer, -offset), centerState.v);
  return [
    {
      assetId: 'pdb-5i4r',
      build: () => generateProteinEnemy(`${name}-ATTACKER`, centerState, 'pdb-5i4r', display, worldSfx, fx, scene, formationId, 'attacker'),
    },
    {
      assetId: 'pdb-8ruc-rubisco',
      build: () => generateProteinEnemy(`${name}-SHIELD`, shieldState, 'pdb-8ruc-rubisco', display, worldSfx, fx, scene, formationId, 'shield'),
    },
    {
      assetId: 'pdb-6n2y-atp-synthase',
      build: () => generateProteinEnemy(`${name}-ENERGY`, energyState, 'pdb-6n2y-atp-synthase', display, worldSfx, fx, scene, formationId, 'energy'),
    },
  ];
}

// base から dAlong だけ進んだ位置に漂う敵を生成する。
export function generatePhasedEnemy(name: string, base: KinematicState, dAlong: number, accent: string | number, orbitLineColor: string | number, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  return generateDriftingEnemy(name, phasedState(base, dAlong), accent, orbitLineColor, worldSfx, fx, scene);
}

// base から dAlong だけ進め、高度を altitudeOffset ぶんずらした円軌道上に敵を生成する。
export function generateCoellipticEnemy(
  name: string, base: KinematicState, dAlong: number, altitudeOffset: number, accent: string | number, orbitLineColor: string | number, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const altitude = len(base.r) + altitudeOffset;
  const state: KinematicState = kinematicState<'eci'>(
    phased.t,
    scale(norm(phased.r), altitude),
    scale(norm(phased.v), Math.sqrt(MU_EARTH / altitude)),
  );
  return generateDriftingEnemy(name, state, accent, orbitLineColor, worldSfx, fx, scene);
}

// base から dAlong だけ進め、軌道面をわずかに傾けた交差軌道上に敵を生成する。
export function generateCrossingEnemy(
  name: string, base: KinematicState, dAlong: number, accent: string | number, orbitLineColor: string | number, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const state: KinematicState = kinematicState<'eci'>(phased.t, phased.r, rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, worldSfx, fx, scene);
}

// base から dAlong だけ進め、速度を増して離心軌道上に敵を生成する。
export function generateEllipticEnemy(
  name: string, base: KinematicState, dAlong: number, accent: string | number, orbitLineColor: string | number, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const state: KinematicState = kinematicState<'eci'>(phased.t, phased.r, scale(phased.v, 1.006));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, worldSfx, fx, scene);
}

// 自機と無関係な軌道要素から作るモルニヤ軌道の敵。t は生成時刻(state のエポック)。
export function generateMolniyaEnemy(
  name: string, t: number, raan: number, nu: number, accent: string | number, orbitLineColor: string | number, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const rp = R_EARTH + 1200e3;
  const ra = R_EARTH + 39400e3;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const state = stateFromOrbitalElements(t, a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu, MU_EARTH);
  return generateDriftingEnemy(name, state, accent, orbitLineColor, worldSfx, fx, scene);
}

// ステージ00ウェーブ敵: 自機へのフライパスなので、機首をプログレードに向けて生成する。
export function generateApproachingEnemy(
  name: string, state: KinematicState, accent: number, orbitLineColor: number, typeIndex: number, waveId: number | undefined, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  return new MetalEnemy(
    {
      name,
      state,
      // 機首をプログレードへ向ける
      q: qFromForwardUp(state.v, state.r) ?? randomQuat(),
      w: v3(0, 0, 0),
      accent,
      orbitLineColor,
      waveId,
      typeIndex,
    },
    worldSfx,
    fx,
    scene,
  );
}
