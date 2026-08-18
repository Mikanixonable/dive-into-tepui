// 個々の敵機を、名前・軌道状態・色などのパラメータから直接生成する。姿勢方針は2つあり、
// 無秩序に漂うものと、機首をプログレードへ向けて接近するものを与える。
import { qFromForwardUp, randomQuat } from '../../../physics/attitude';
import { KinematicState, kinematicState, orbitAxes } from '../../../physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../../physics/solar-system';
import { stateFromOrbitalElements } from '../../../physics/elements';
import { randSym } from '../../../physics/random';
import { len, norm, rotateAxis, scale, v3 } from '../../../physics/vec3';
import { diagonalInertia } from '../../../physics/inertia-tensor';
import { Vessel, type VesselDeps } from '../../vessel/vessel';
import { inertiaForEnemyKind } from '../../vessel/enemy-ai';

// 自機軌道(base)を dAlong だけ進めた位置の軌道状態(プリセット配置の共通基盤)。
function phasedState(base: KinematicState, dAlong: number): KinematicState {
  const hHat = orbitAxes(base).nrm;
  const ang = dAlong / len(base.r);
  return kinematicState(base.t, rotateAxis(base.r, hHat, ang), rotateAxis(base.v, hHat, ang));
}

// 無秩序に漂う敵(訓練クラスタ・通常ステージのプリセット敵の生成本体): ランダム姿勢+角速度。
export function generateDriftingEnemy(name: string, state: KinematicState, accent: string | number, orbitLineColor: string | number, deps: VesselDeps): Vessel {
  return new Vessel(
    { hostileShip: {
      name,
      state,
      enemyKind: { kind: 'drifting' },
      att: {
        // ランダムな姿勢・角速度を与える
        q: randomQuat(),
        w: v3(randSym(0.12), randSym(0.12), randSym(0.12)),
        inertia: diagonalInertia(inertiaForEnemyKind({ kind: 'drifting' })),
      },
      accent,
      orbitLineColor,
    } },
    deps,
  );
}

// base から dAlong だけ進んだ位置に漂う敵を生成する。
export function generatePhasedEnemy(name: string, base: KinematicState, dAlong: number, accent: string | number, orbitLineColor: string | number, deps: VesselDeps): Vessel {
  return generateDriftingEnemy(name, phasedState(base, dAlong), accent, orbitLineColor, deps);
}

// base から dAlong だけ進め、高度を altitudeOffset ぶんずらした円軌道上に敵を生成する。
export function generateCoellipticEnemy(
  name: string, base: KinematicState, dAlong: number, altitudeOffset: number, accent: string | number, orbitLineColor: string | number, deps: VesselDeps,
): Vessel {
  const phased = phasedState(base, dAlong);
  const altitude = len(base.r) + altitudeOffset;
  const state: KinematicState = kinematicState(
    phased.t,
    scale(norm(phased.r), altitude),
    scale(norm(phased.v), Math.sqrt(MU_EARTH / altitude)),
  );
  return generateDriftingEnemy(name, state, accent, orbitLineColor, deps);
}

// base から dAlong だけ進め、軌道面をわずかに傾けた交差軌道上に敵を生成する。
export function generateCrossingEnemy(
  name: string, base: KinematicState, dAlong: number, accent: string | number, orbitLineColor: string | number, deps: VesselDeps,
): Vessel {
  const phased = phasedState(base, dAlong);
  const state: KinematicState = kinematicState(phased.t, phased.r, rotateAxis(phased.v, norm(phased.r), (0.4 * Math.PI) / 180));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, deps);
}

// base から dAlong だけ進め、速度を増して離心軌道上に敵を生成する。
export function generateEllipticEnemy(
  name: string, base: KinematicState, dAlong: number, accent: string | number, orbitLineColor: string | number, deps: VesselDeps,
): Vessel {
  const phased = phasedState(base, dAlong);
  const state: KinematicState = kinematicState(phased.t, phased.r, scale(phased.v, 1.006));
  return generateDriftingEnemy(name, state, accent, orbitLineColor, deps);
}

// t = 生成時刻(state のエポック)。他のプリセットが base(自機状態)から引き継ぐのに対し、
// この軌道は自機と無関係に軌道要素から作るので、時刻だけ呼び出し側から受け取る。
export function generateMolniyaEnemy(
  name: string, t: number, raan: number, nu: number, accent: string | number, orbitLineColor: string | number, deps: VesselDeps,
): Vessel {
  const rp = R_EARTH + 1200e3;
  const ra = R_EARTH + 39400e3;
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  const state = stateFromOrbitalElements(t, a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu, MU_EARTH);
  return generateDriftingEnemy(name, state, accent, orbitLineColor, deps);
}

// ステージ00ウェーブ敵: 自機へのフライパスなので、機首をプログレードに向けて生成する。
export function generateApproachingEnemy(
  name: string, state: KinematicState, accent: number, orbitLineColor: number, typeIndex: number, waveId: number, deps: VesselDeps,
): Vessel {
  return new Vessel(
    { hostileShip: {
      name,
      state,
      enemyKind: { kind: 'stage0', typeIndex },
      att: {
        // 機首をプログレードへ向ける
        q: qFromForwardUp(state.v, state.r) ?? randomQuat(),
        w: v3(0, 0, 0),
        inertia: diagonalInertia(inertiaForEnemyKind({ kind: 'stage0', typeIndex })),
      },
      accent,
      orbitLineColor,
      waveId,
    } },
    deps,
  );
}
