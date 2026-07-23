// 個々の敵機を、kind・座標・色などのパラメータから直接生成する。
// 中間データ(spec/preset)は持たない — 呼び出し側(各 Stage、stages/)がこの関数を直接呼んで
// Enemy を得る。意図的に異なる2つの姿勢方針(無秩序に漂う/プログレードで接近する)を
// この1ファイルに並べて置き、互いを見比べやすくする。
import * as THREE from 'three/webgpu';
import { qFromForwardUp, randomQuat } from '../../../physics/attitude';
import { MU_EARTH, OrbitState, R_EARTH, stateFromElements } from '../../../physics/orbital';
import { cross, len, norm, randSym, rotateAxis, scale, v3 } from '../../../physics/vec3';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import { Enemy } from '../../orbit-entity/enemy';

// 自機軌道(base)を dAlong だけ進めた位置の軌道状態(プリセット配置の共通基盤)。
function phasedState(base: OrbitState, dAlong: number): OrbitState {
  const hHat = norm(cross(base.r, base.v));
  const ang = dAlong / len(base.r);
  return { r: rotateAxis(base.r, hHat, ang), v: rotateAxis(base.v, hHat, ang) };
}

// 無秩序に漂う敵(訓練クラスタ・通常ステージのプリセット敵の生成本体): ランダム姿勢+角速度。
export function generateDriftingEnemy(name: string, state: OrbitState, hp: number, accent: number, orbitLineColor: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  return new Enemy(
    name,
    state,
    { kind: 'drifting' },
    {
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

export function generatePhasedEnemy(name: string, base: OrbitState, dAlong: number, hp: number, accent: number, orbitLineColor: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  return generateDriftingEnemy(name, phasedState(base, dAlong), hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

export function generateCoellipticEnemy(
  name: string, base: OrbitState, dAlong: number, altitudeOffset: number, hp: number, accent: number, orbitLineColor: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene,
): Enemy {
  const phased = phasedState(base, dAlong);
  const altitude = len(base.r) + altitudeOffset;
  const state: OrbitState = {
    r: scale(norm(phased.r), altitude),
    v: scale(norm(phased.v), Math.sqrt(MU_EARTH / altitude)),
  };
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

export function generateCrossingEnemy(name: string, base: OrbitState, dAlong: number, hp: number, accent: number, orbitLineColor: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  const phased = phasedState(base, dAlong);
  const state: OrbitState = { r: phased.r, v: rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180) };
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

export function generateEllipticEnemy(name: string, base: OrbitState, dAlong: number, hp: number, accent: number, orbitLineColor: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  const phased = phasedState(base, dAlong);
  const state: OrbitState = { r: phased.r, v: scale(phased.v, 1.006) };
  return generateDriftingEnemy(name, state, hp, accent, orbitLineColor, hud, sfx, fx, scene);
}

export function generateMolniyaEnemy(name: string, raan: number, nu: number, hp: number, accent: number, orbitLineColor: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene): Enemy {
  const rp = R_EARTH + 1200e3;
  const ra = R_EARTH + 39400e3;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const state = stateFromElements(a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu);
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
