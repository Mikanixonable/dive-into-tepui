// 個々の敵機を、kind・座標・色などのパラメータから直接生成する。
// 中間データ(spec/preset)は持たない — 呼び出し側(各 Stage、stages/)がこの関数を直接呼んで
// Enemy を得る。意図的に異なる2つの姿勢方針(無秩序に漂う/プログレードで接近する)を
// この1ファイルに並べて置き、互いを見比べやすくする。
import * as THREE from 'three/webgpu';
import { qFromForwardUp, randomQuat } from '../../../physics/attitude';
import { MU_EARTH, OrbitState, R_EARTH, orbitState, orbitalAxes, stateFromElements } from '../../../physics/orbital';
import { len, norm, randSym, rotateAxis, scale, v3 } from '../../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../game-entity/enemy';

// 自機軌道(base)を dAlong だけ進めた位置の軌道状態(プリセット配置の共通基盤)。
function phasedState(base: OrbitState, dAlong: number): OrbitState {
  const hHat = orbitalAxes(base).nrm;
  const ang = dAlong / len(base.r);
  return orbitState(base.t, rotateAxis(base.r, hHat, ang), rotateAxis(base.v, hHat, ang));
}

// 無秩序に漂う敵(訓練クラスタ・通常ステージのプリセット敵の生成本体): ランダム姿勢+角速度。
export function generateDriftingEnemy(name: string, state: OrbitState, hp: number, accent: string | number, orbitLineColor: string | number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  return new Enemy(
    name,
    state,
    { kind: 'drifting' },
    {
      // ランダムな姿勢・角速度を与える
      q: randomQuat(),
      w: v3(randSym(0.12), randSym(0.12), randSym(0.12)),
      inertia: v3(1, 1.1, 1.05),
    },
    hp,
    accent,
    orbitLineColor,
    hud,
    sfx,
    fx,
    undefined,
    scene,
  );
}

// base から dAlong だけ進んだ位置に漂う敵を生成する。
export function generatePhasedEnemy(name: string, base: OrbitState, dAlong: number, hp: number, accent: string | number, orbitLineColor: string | number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  return generateDriftingEnemy(name, phasedState(base, dAlong), hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

// base から dAlong だけ進め、高度を altitudeOffset ぶんずらした円軌道上に敵を生成する。
export function generateCoellipticEnemy(
  name: string, base: OrbitState, dAlong: number, altitudeOffset: number, hp: number, accent: string | number, orbitLineColor: string | number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const altitude = len(base.r) + altitudeOffset;
  const state: OrbitState = orbitState(
    phased.t,
    scale(norm(phased.r), altitude),
    scale(norm(phased.v), Math.sqrt(MU_EARTH / altitude)),
  );
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

// base から dAlong だけ進め、軌道面をわずかに傾けた交差軌道上に敵を生成する。
export function generateCrossingEnemy(
  name: string, base: OrbitState, dAlong: number, hp: number, accent: string | number, orbitLineColor: string | number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const state: OrbitState = orbitState(phased.t, phased.r, rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180));
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

// base から dAlong だけ進め、速度を増して離心軌道上に敵を生成する。
export function generateEllipticEnemy(
  name: string, base: OrbitState, dAlong: number, hp: number, accent: string | number, orbitLineColor: string | number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const state: OrbitState = orbitState(phased.t, phased.r, scale(phased.v, 1.006));
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

// t = 生成時刻(state のエポック)。他のプリセットが base(自機状態)から引き継ぐのに対し、
// この軌道は自機と無関係に軌道要素から作るので、時刻だけ呼び出し側から受け取る。
export function generateMolniyaEnemy(
  name: string, t: number, raan: number, nu: number, hp: number, accent: string | number, orbitLineColor: string | number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const rp = R_EARTH + 1200e3;
  const ra = R_EARTH + 39400e3;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const state = stateFromElements(t, a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu, MU_EARTH);
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

// ステージ00ウェーブ敵: 自機へのフライパスなので、機首をプログレードに向けて生成する。
export function generateApproachingEnemy(
  name: string, state: OrbitState, hp: number, accent: number, orbitLineColor: number, typeIndex: number, waveId: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  return new Enemy(
    name,
    state,
    { kind: 'stage0', typeIndex },
    {
      // 機首をプログレードへ向ける
      q: qFromForwardUp(state.v, state.r) ?? randomQuat(),
      w: v3(0, 0, 0),
      inertia: v3(1, 1, 1),
    },
    hp,
    accent,
    orbitLineColor,
    hud,
    sfx,
    fx,
    waveId,
    scene,
  );
}
