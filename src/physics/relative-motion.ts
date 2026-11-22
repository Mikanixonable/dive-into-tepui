// 近距離の相対運動。目標天体のまわりを回る艦の、目標との相対位置・相対速度を
// Clohessy-Wiltshire(ヒル)方程式で扱う純関数群。ランデブー・待機点・接近点の
// 終端誘導の初値を出すためにある(何十km以上離れた航路そのものはランベルトが担う)。
// 基準: 真円に近い目標軌道・非推力の間は線形に従う — 出した Δv は初値であり、
// 実行側は全力モデルで残差を修正する。
// THREE/DOM 非依存。
import { add, addScaled, cross, lenSq, scale, sub, type Vec3, v3 } from '../math/vec3';
import { kinematicState, type KinematicState } from './kinematic-state';

// 3x3 行列の行優先の平置き。インデックスは (i, j) → i*3+j。
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

// ヒル座標系: x = 動径方向(中心天体から外へ)、y = 軌道進行方向、z = 軌道面法線。
// 状態は (x, y, z, vx, vy, vz) の6成分。ここでは Vec3 の対で受け渡す。
interface RelativeState {
  readonly r: Vec3;
  readonly v: Vec3;
}

// CW の状態遷移行列。n は目標の平均運動 [rad/s]、t は経過時間 [s]。
// δr(t) = Φ_rr·δr₀ + Φ_rv·δv₀、δv(t) = Φ_vr·δr₀ + Φ_vv·δv₀。
// 行列は行優先の平置き Mat3 で返し、呼び出し側が Vec3 の成分ごとに適用する。
const s_ = (n: number, t: number) => Math.sin(n * t);
const c_ = (n: number, t: number) => Math.cos(n * t);

// Φ_rr (行優先)。教科書どおりの配置:
// [ 4−3c,   0,    0 ]
// [ 6(s−nt), 1,   0 ]
// [ 0,      0,    c ]
function cwPhiRR(n: number, t: number): Mat3 {
  const s = s_(n, t), c = c_(n, t);
  return [
    4 - 3 * c, 0, 0,
    6 * (s - n * t), 1, 0,
    0, 0, c,
  ];
}

// Φ_rv:
// [ s/n,        2(1−c)/n, 0 ]
// [ −2(1−c)/n, (4s−3nt)/n, 0 ]
// [ 0,          0,        s/n ]
function cwPhiRV(n: number, t: number): Mat3 {
  const s = s_(n, t), c = c_(n, t);
  return [
    s / n, (2 * (1 - c)) / n, 0,
    (-2 * (1 - c)) / n, (4 * s - 3 * n * t) / n, 0,
    0, 0, s / n,
  ];
}

// Φ_vr = d(Φ_rr)/dt:
// [ 3n s,   0,    0 ]
// [ 6n(c−1), 0,   0 ]
// [ 0,      0,   −n s ]
function cwPhiVR(n: number, t: number): Mat3 {
  const s = s_(n, t), c = c_(n, t);
  return [
    3 * n * s, 0, 0,
    6 * n * (c - 1), 0, 0,
    0, 0, -n * s,
  ];
}

// Φ_vv = d(Φ_rv)/dt:
// [ c,     2s,    0 ]
// [ −2s,   4c−3,  0 ]
// [ 0,     0,     c ]
function cwPhiVV(n: number, t: number): Mat3 {
  const s = s_(n, t), c = c_(n, t);
  return [
    c, 2 * s, 0,
    -2 * s, 4 * c - 3, 0,
    0, 0, c,
  ];
}

function applyMat(m: Mat3, v: Vec3): Vec3 {
  const x = v.x, y = v.y, z = v.z;
  return v3(
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  );
}

// 3x3 行列の逆行列。特異なら null。
// ヒル座標では Φ_rv は非特異(t が n の半周期の整数倍でない限り)。
function invert3x3(m: Mat3): Mat3 | null {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = m;
  const det = a00 * (a11 * a22 - a12 * a21)
    - a01 * (a10 * a22 - a12 * a20)
    + a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 1e-20) return null;
  const inv = 1 / det;
  return [
    (a11 * a22 - a12 * a21) * inv, (a02 * a21 - a01 * a22) * inv, (a01 * a12 - a02 * a11) * inv,
    (a12 * a20 - a10 * a22) * inv, (a00 * a22 - a02 * a20) * inv, (a02 * a10 - a00 * a12) * inv,
    (a10 * a21 - a11 * a20) * inv, (a01 * a20 - a00 * a21) * inv, (a00 * a11 - a01 * a10) * inv,
  ];
}

// 相対状態を時刻 t へ伝播する。
export function cwPropagate(state: RelativeState, n: number, t: number): RelativeState {
  const rr = applyMat(cwPhiRR(n, t), state.r);
  const rv = applyMat(cwPhiRV(n, t), state.v);
  const vr = applyMat(cwPhiVR(n, t), state.r);
  const vv = applyMat(cwPhiVV(n, t), state.v);
  return { r: addScaled(rr, rv, 1), v: addScaled(vr, vv, 1) };
}

// 2インパルス相対遷移: いまの相対状態 state から、時刻 t に相対位置 targetR へ届くための
// 出発 Δv と到着点で目標の相対速度(既定 0 = 同速)に合わせる到着 Δv を返す。
// δv₀ = Φ_rv⁻¹ (targetR − Φ_rr·δr₀)。Φ_rv が特異(nt が π の整数倍付近)なら null。
export function cwTwoImpulseTransfer(
  state: RelativeState,
  n: number,
  t: number,
  targetR: Vec3,
  targetV: Vec3 = v3(),
): { departDeltaV: Vec3; arriveDeltaV: Vec3 } | null {
  const invRV = invert3x3(cwPhiRV(n, t));
  if (!invRV) return null;
  // 自由伝播の終端位置は初速度の効果も含む(Φ_rr·δr₀ + Φ_rv·δv₀)。
  const needed = sub(targetR, cwPropagate(state, n, t).r);
  const vAfterBurn = addScaled(state.v, applyMat(invRV, needed), 1);
  const departDeltaV = sub(vAfterBurn, state.v);
  const arrived = cwPropagate({ r: state.r, v: vAfterBurn }, n, t);
  const arriveDeltaV = sub(targetV, arrived.v);
  return { departDeltaV, arriveDeltaV };
}

// ── 目標の回転局所系(LVLH) ──

// 目標の回転局所系(LVLH)。x = 動径外向き、z = 軌道面法線、y = z×x(面内の進行方向)。
// CW 方程式と同じ軸の取り方。omega は系の瞬間角速度 h/r² [rad/s]、
// n はその大きさ(円軌道では平均運動に一致する)。
export interface LocalFrame {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
  readonly omega: Vec3;
  readonly n: number;
}

// 中心天体相対の目標状態から局所系を組む。動径と角運動量が縮退していると null。
export function localFrameOf(relR: Vec3, relV: Vec3): LocalFrame | null {
  const rSq = lenSq(relR);
  const h = cross(relR, relV);
  const hLen = Math.sqrt(lenSq(h));
  if (!(rSq > 0) || !(hLen > 0)) return null;
  const x = scale(relR, 1 / Math.sqrt(rSq));
  const z = scale(h, 1 / hLen);
  return { x, y: cross(z, x), z, omega: scale(h, 1 / rSq), n: hLen / rSq };
}

// 局所系の成分(動径・面内進行・法線)で表した方向を ECI 方向へ写す。
export function frameDirectionToEci(frame: LocalFrame, hill: Vec3): Vec3 {
  return addScaled(addScaled(scale(frame.x, hill.x), frame.y, hill.y), frame.z, hill.z);
}

// 局所系の固定点(offset は Hill 成分 [m])の ECI 状態。速度は v_target + ω×r_off で
// 系内では静止 — この状態へ到着した艦はその場で目標に対して保持になる。
// 目標の局所系が組めないとき null。
export function holdStateAt(
  targetState: KinematicState, centerState: KinematicState, offset: Vec3,
): KinematicState | null {
  const frame = localFrameOf(
    sub(targetState.r, centerState.r), sub(targetState.v, centerState.v));
  if (frame === null) return null;
  const rOff = frameDirectionToEci(frame, offset);
  return kinematicState<'eci'>(
    targetState.t,
    add(targetState.r, rOff),
    add(targetState.v, cross(frame.omega, rOff)),
  );
}
