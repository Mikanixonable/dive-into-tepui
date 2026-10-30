// 射撃法による軌道補正。初期位置と到着時刻を固定し、初速度だけを変えて、全力モデルで
// 伝播した終端位置を目標位置へ合わせる。ランベルトや CW が出した二体/線形の初値を、
// J2・大気・多体を含む実モデルの解へ寄せるためにある。
// 伝播は呼び出し側が渡す関数に任せる — この層は全力モデルを知らず、
// 「入力が同じなら出力も同じ」という純粋計算の形だけを持つ。
import { type KinematicState, kinematicState } from './kinematic-state';
import { add, addScaled, len, sub, v3, type Vec3 } from '../math/vec3';

export interface ShootingResult {
  readonly velocity: Vec3; // 補正済みの初速度 [m/s]
  readonly residual: number; // 終端位置の残り誤差 [m]
  readonly iterations: number;
  readonly converged: boolean;
}

// 3x3 連立 A·x = b をクラメールの公式で解く。特異なら null。
// 係数は行優先の9成分、未知数は [x, y, z] の順。
function solve3(
  a: readonly [number, number, number, number, number, number, number, number, number],
  b: readonly [number, number, number],
): [number, number, number] | null {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const det = a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 1e-30) return null;
  const [b0, b1, b2] = b;
  const dx = b0 * (a11 * a22 - a12 * a21)
    - a01 * (b1 * a22 - a12 * b2)
    + a02 * (b1 * a21 - a11 * b2);
  const dy = a00 * (b1 * a22 - a12 * b2)
    - b0 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * b2 - b1 * a20);
  const dz = a00 * (a11 * b2 - b1 * a21)
    - a01 * (a10 * b2 - b1 * a20)
    + b0 * (a10 * a21 - a11 * a20);
  return [dx / det, dy / det, dz / det];
}

// state.t から tTarget まで propagate した終端位置が targetR になるよう初速度を補正する。
// - propagate(state, tTarget): 与えた初期状態を時刻 tTarget まで全力モデルで進めた終端状態。
//   必ず状態・時刻だけから決まる(内部時計や乱数を持たない)関数を渡す。
// - tolerance: 終端位置の許容誤差 [m]。
// - deltaVStep: 感度行列の有限差分刻み [m/s]。積分刻みより小さくしすぎると差分が
//   数値ノイズに埋まるので、伝播1歩で進む距離が差分位置より十分大きい値を取る。
// 収束しなかった場合も最良の速度を converged=false で返す(呼び出し側が捨てるかは自由)。
export function correctInitialVelocity(
  state: KinematicState,
  targetR: Vec3,
  tTarget: number,
  propagate: (state: KinematicState, t: number) => KinematicState,
  opts: { maxIterations?: number; tolerance?: number; deltaVStep?: number } = {},
): ShootingResult {
  const { maxIterations = 8, tolerance = 1, deltaVStep = 0.01 } = opts;
  let v: Vec3 = v3(state.v.x, state.v.y, state.v.z);
  let lastResidual = Infinity;

  for (let iter = 0; iter < maxIterations; iter++) {
    const base = kinematicState<'eci'>(state.t, state.r, v);
    const end = propagate(base, tTarget);
    const residual = sub(end.r, targetR);
    const resLen = len(residual);
    lastResidual = resLen;
    if (resLen <= tolerance) {
      return { velocity: v, residual: resLen, iterations: iter + 1, converged: true };
    }

    // 感度行列 Φ_rv: 各速度成分を deltaVStep だけ動かしたときの終端位置の変化。
    const col = (axis: Vec3): Vec3 => {
      const perturbed = kinematicState<'eci'>(state.t, state.r, addScaled(v, axis, deltaVStep));
      const endP = propagate(perturbed, tTarget);
      return v3(
        (endP.r.x - end.r.x) / deltaVStep,
        (endP.r.y - end.r.y) / deltaVStep,
        (endP.r.z - end.r.z) / deltaVStep,
      );
    };
    const c0 = col(v3(1, 0, 0));
    const c1 = col(v3(0, 1, 0));
    const c2 = col(v3(0, 0, 1));
    const dv = solve3(
      [c0.x, c1.x, c2.x, c0.y, c1.y, c2.y, c0.z, c1.z, c2.z],
      [-residual.x, -residual.y, -residual.z],
    );
    if (dv === null) {
      return { velocity: v, residual: resLen, iterations: iter + 1, converged: false };
    }
    const [dvx, dvy, dvz] = dv;
    v = add(v, v3(dvx, dvy, dvz));
  }
  return { velocity: v, residual: lastResidual, iterations: maxIterations, converged: false };
}
