// 姿勢制御アクチュエータへの指令の配分。要求トルク(と要求並進推力)を、磁気トルカ →
// フライホイール → RCSスラスタの3段の優先順位で割り当てる。前の段が出せなかったぶんだけが
// 次の段へ落ち、最後に残ったぶんは出せなかったものとして捨てる。
//
// 3段の順序は消費するものの順序である。磁気トルカは推進剤も要らず電力も微小、フライホイールは
// 電力だけ、RCSスラスタは推進剤を消費する。磁気トルカが出せるトルクは実際には他の2つより桁で
// 小さいが、蓄積角運動量を時間をかけて外へ捨てる用途では、その小ささが問題にならない。

import { Vec3, add, cross, dot, len, lenSq, norm, scale, sub, v3 } from './vec3';

// RCSスラスタ1基。position は重心から測った機体座標の取付位置 [m]、direction は噴射によって
// 機体が受ける力の向き(単位ベクトル、噴射方向の逆)、maxThrust は最大推力 [N]。
export interface ThrusterSpec {
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly maxThrust: number;
}

// フライホイール(健全なもの全体を1基とみなした合成値)。
export interface WheelSpec {
  readonly maxTorque: number; // N·m
  readonly maxAngularMomentum: number; // N·m·s
  readonly powerDraw: number; // W
}

// 磁気トルカ(同上)。
export interface MagnetorquerSpec {
  readonly maxMagneticMoment: number; // A·m^2
  readonly powerDraw: number; // W
}

// 機体1隻が持つアクチュエータ一式。積んでいない種別は null。
export interface ActuatorSet {
  readonly thrusters: readonly ThrusterSpec[];
  readonly wheel: WheelSpec | null;
  readonly magnetorquer: MagnetorquerSpec | null;
}

// 姿勢制御への要求。いずれも機体座標。
export interface ControlRequest {
  readonly torque: Vec3; // N·m
  readonly force: Vec3; // N
}

// 配分の結果。各アクチュエータへの指令と、実際に出せたトルク・並進推力・消費電力。
export interface Allocation {
  readonly magneticMoment: Vec3; // A·m^2(機体座標)
  readonly wheelTorque: Vec3; // N·m(機体座標)
  readonly wheelMomentum: Vec3; // この刻みのあとのホイールの蓄積角運動量 [N·m·s]
  readonly thrusterForces: readonly number[]; // actuators.thrusters と同じ順の推力 [N]
  readonly torque: Vec3; // 機体が実際に受けるトルク [N·m]
  readonly force: Vec3; // 機体が実際に受ける並進推力 [N]
  readonly powerDraw: number; // W
}

// アンローディングを始める蓄積角運動量の割合と、終える割合。開始が高いのは通常の運用で排出が
// 頻発しないため、終了が低いのは1回の排出で当分は再発しない余裕を作るためである。2値の比が
// 大きいほど、開始と終了を短周期で往復する発振から遠い。
export const DESATURATION_START_RATIO = 0.85;
export const DESATURATION_STOP_RATIO = 0.30;

// アンローディングが目標とする排出の時定数 [s]。蓄積角運動量をこの時間で捨てきる大きさの
// 外部トルクを要求する。実際に出せる大きさは磁気トルカとRCSの能力で決まるので、磁気トルカ
// しか積まない機体では要求のごく一部しか通らず、排出は数時間かけて進む。
export const DESATURATION_TIME_CONSTANT = 60;

// 減衰最小二乗の正則化重みを決める相対値。λ = (Aの最大特異値 × この値)^2 とする。特異値の2乗で
// 入るのは A·Aᵀ の対角へ足すためであり、相対値で置くのは機体の大小でスラスタの推力が桁で
// 変わるためである。この大きさは「解の存在しない方向」だけを丸め、対称な配置では影響しない。
export const REGULARIZATION_RATIO = 1e-3;

// 蓄積角運動量からアンローディングの実施可否を判定する。active は前回の判定結果で、開始と終了に
// 別々の閾値を持たせるために要る。
export function desaturationActive(momentum: Vec3, wheel: WheelSpec | null, active: boolean): boolean {
  if (!wheel || !(wheel.maxAngularMomentum > 0)) return false;
  const ratio = len(momentum) / wheel.maxAngularMomentum;
  return active ? ratio > DESATURATION_STOP_RATIO : ratio > DESATURATION_START_RATIO;
}

// アンローディング中にフライホイールへ与える減速トルク [N·m]。蓄積角運動量と同じ向きを持ち、
// このトルクを出すあいだ dh/dt = −τ_wheel によって蓄積が減る。dt でこの刻みの排出量が
// 蓄積を超えないよう頭打ちにするので、0 を跨いで逆向きに溜まることはない。
export function desaturationTorque(momentum: Vec3, wheel: WheelSpec, dt: number): Vec3 {
  const h = len(momentum);
  if (!(h > 0)) return v3();
  const rate = Math.min(wheel.maxTorque, h / DESATURATION_TIME_CONSTANT, dt > 0 ? h / dt : Infinity);
  return scale(momentum, rate / h);
}

// 磁気モーメント m が磁場 field の下で target に最も近いトルクを出すときの m。τ = m × B は B に
// 平行な成分を出せないので、返る m が生むのは target の B に垂直な成分だけである。磁場が無い
// 領域では零ベクトルを返す。
export function magneticMomentFor(target: Vec3, field: Vec3, maxMoment: number): Vec3 {
  const b2 = lenSq(field);
  if (!(b2 > 0) || !(maxMoment > 0)) return v3();
  const moment = scale(cross(field, target), 1 / b2);
  const m = len(moment);
  return m > maxMoment ? scale(moment, maxMoment / m) : moment;
}

// 要求をアクチュエータへ配分する。momentum はこの刻みの前のフライホイールの蓄積角運動量、
// field は機体座標での磁束密度 [T]、desaturating はアンローディング中かどうか。
//
// 通常は 磁気トルカ → フライホイール → RCS の順に、前段が出せなかった残りを次段へ渡す。
// アンローディング中はフライホイールの指令を排出方向へ固定し、要求トルクは磁気トルカと RCS で
// 賄う — ホイールが要求を先に取ってしまうと蓄積が減らないためである。
export function allocateControl(
  request: ControlRequest,
  actuators: ActuatorSet,
  momentum: Vec3,
  field: Vec3,
  dt: number,
  desaturating: boolean,
): Allocation {
  const { wheel, magnetorquer } = actuators;

  let wheelTorque = v3();
  let magneticMoment = v3();
  let magneticTorque = v3();

  if (desaturating && wheel) {
    wheelTorque = desaturationTorque(momentum, wheel, dt);
    magneticMoment = magnetorquer
      ? magneticMomentFor(sub(request.torque, wheelTorque), field, magnetorquer.maxMagneticMoment)
      : v3();
    magneticTorque = cross(magneticMoment, field);
  } else {
    magneticMoment = magnetorquer
      ? magneticMomentFor(request.torque, field, magnetorquer.maxMagneticMoment)
      : v3();
    magneticTorque = cross(magneticMoment, field);
    if (wheel) wheelTorque = clampWheelTorque(sub(request.torque, magneticTorque), wheel, momentum, dt);
  }

  const residual = sub(sub(request.torque, magneticTorque), wheelTorque);
  const thrusterForces = allocateThrusters(actuators.thrusters, request.force, residual);
  const thrusterWrench = wrenchOf(actuators.thrusters, thrusterForces);

  const powerDraw =
    (wheel && lenSq(wheelTorque) > 0 ? wheel.powerDraw : 0) +
    (magnetorquer && magnetorquer.maxMagneticMoment > 0
      ? (magnetorquer.powerDraw * len(magneticMoment)) / magnetorquer.maxMagneticMoment
      : 0);

  return {
    magneticMoment,
    wheelTorque,
    wheelMomentum: sub(momentum, scale(wheelTorque, dt)),
    thrusterForces,
    torque: add(add(magneticTorque, wheelTorque), thrusterWrench.torque),
    force: thrusterWrench.force,
    powerDraw,
  };
}

// フライホイールの指令トルクを、最大トルクと蓄積角運動量の上限の両方で頭打ちにする。
// 上限を超える向きの指令は、超えない最大の倍率まで縮める。
function clampWheelTorque(target: Vec3, wheel: WheelSpec, momentum: Vec3, dt: number): Vec3 {
  const magnitude = len(target);
  if (!(magnitude > 0) || !(wheel.maxTorque > 0)) return v3();
  let torque = magnitude > wheel.maxTorque ? scale(target, wheel.maxTorque / magnitude) : target;
  const hMax = wheel.maxAngularMomentum;
  if (!(dt > 0) || !(hMax > 0)) return torque;

  // |momentum − s·τ·dt| ≤ hMax を満たす最大の s ∈ [0, 1] を求める。s の2次式なので閉形式で解ける。
  const step = scale(torque, dt);
  const a = lenSq(step);
  if (!(a > 0)) return torque;
  const b = -2 * dot(momentum, step);
  const c = lenSq(momentum) - hMax * hMax;
  if (a + b + c <= 0) return torque;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return v3();
  const s = (-b + Math.sqrt(disc)) / (2 * a);
  return scale(torque, Math.max(0, Math.min(1, s)));
}

// RCSスラスタへ、要求並進推力と要求トルクを減衰最小二乗で配分する。
// A を各スラスタの [力; トルク] を列に並べた 6×n 行列として F = Aᵀ(A·Aᵀ + λI)⁻¹ b を解き、
// 各推力を 0 以上・最大推力以下へ丸める。対向するスラスタの列は互いに符号が逆なので、この解では
// 必ず一方が負となり 0 へ丸められる — 同時に噴くことはない。
//
// 負を丸めると、対向する2基が担っていた分の片側が消えるため、そのままでは出力が要求の半分に
// なる。丸めたあとに全基へ共通の倍率を1つ掛け、残差を最小にする倍率を閉形式で求めて補う —
// 推力をスラスタ間で付け替えるのではなく全体を同じだけ強めるので、対向するスラスタが同時に
// 噴くことはなく、最大推力を超える基が出れば倍率のほうが頭打ちになる。
function allocateThrusters(
  thrusters: readonly ThrusterSpec[],
  force: Vec3,
  torque: Vec3,
): readonly number[] {
  if (thrusters.length === 0) return [];
  const columns = thrusters.map((t) => columnOf(t));
  const gram = gramMatrix(columns);
  const lambda = (largestSingularValue(gram) * REGULARIZATION_RATIO) ** 2;
  for (let i = 0; i < 6; i++) gram[i]![i]! += lambda;

  const b = [force.x, force.y, force.z, torque.x, torque.y, torque.z];
  const y = solveSymmetric(gram, b);
  if (!y) return thrusters.map(() => 0);
  const clamped = thrusters.map((t, i) => {
    const column = columns[i]!;
    let f = 0;
    for (let k = 0; k < 6; k++) f += column[k]! * y[k]!;
    return Math.max(0, Math.min(t.maxThrust, f));
  });
  return scaleToRequest(thrusters, columns, clamped, b);
}

// 丸めたあとの推力の組へ、残差 ‖A(gF) − b‖ を最小にする共通の倍率 g を掛ける。g は
// (b·AF)/‖AF‖² で求まり、どの基も最大推力を超えない範囲へ頭打ちにする。1 未満にはしない —
// 最小二乗の解そのものより弱める理由が無いためである。
function scaleToRequest(
  thrusters: readonly ThrusterSpec[],
  columns: readonly (readonly number[])[],
  forces: readonly number[],
  b: readonly number[],
): readonly number[] {
  const achieved = new Array<number>(6).fill(0);
  for (let i = 0; i < forces.length; i++) {
    const f = forces[i]!;
    if (!(f > 0)) continue;
    for (let k = 0; k < 6; k++) achieved[k]! += columns[i]![k]! * f;
  }
  let numerator = 0;
  let denominator = 0;
  for (let k = 0; k < 6; k++) {
    numerator += b[k]! * achieved[k]!;
    denominator += achieved[k]! * achieved[k]!;
  }
  if (!(denominator > 0)) return forces;
  let gain = numerator / denominator;
  if (!(gain > 1)) return forces;
  for (let i = 0; i < forces.length; i++) {
    const f = forces[i]!;
    if (f > 0) gain = Math.min(gain, thrusters[i]!.maxThrust / f);
  }
  return gain > 1 ? forces.map((f) => f * gain) : forces;
}

// スラスタ1基が単位推力で生む [力; トルク] の6成分。
function columnOf(thruster: ThrusterSpec): readonly number[] {
  const f = thruster.direction;
  const m = cross(thruster.position, f);
  return [f.x, f.y, f.z, m.x, m.y, m.z];
}

// A·Aᵀ(6×6 対称)。
function gramMatrix(columns: readonly (readonly number[])[]): number[][] {
  const g: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (const column of columns) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) g[i]![j]! += column[i]! * column[j]!;
  }
  return g;
}

// A の最大特異値。A·Aᵀ の最大固有値の平方根であり、べき乗法で求める。反復回数を固定するのは、
// 収束判定で回数が変わると同じ配置に対する正則化重みがフレームごとに揺れるためである。
function largestSingularValue(gram: readonly (readonly number[])[]): number {
  let v = new Array<number>(6).fill(1 / Math.sqrt(6));
  let value = 0;
  for (let iter = 0; iter < 32; iter++) {
    const w = new Array<number>(6).fill(0);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) w[i]! += gram[i]![j]! * v[j]!;
    const n = Math.hypot(...w);
    if (!(n > 0)) return 0;
    v = w.map((x) => x / n);
    value = n;
  }
  return Math.sqrt(value);
}

// 6×6 の連立一次方程式を部分ピボット選択つきのガウス消去で解く。特異なら null。
function solveSymmetric(m: number[][], b: readonly number[]): number[] | null {
  const a = m.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < 6; col++) {
    let pivot = col;
    for (let row = col + 1; row < 6; row++) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    if (!(Math.abs(a[pivot]![col]!) > 0)) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let row = col + 1; row < 6; row++) {
      const factor = a[row]![col]! / a[col]![col]!;
      for (let k = col; k <= 6; k++) a[row]![k]! -= factor * a[col]![k]!;
    }
  }
  const x = new Array<number>(6).fill(0);
  for (let row = 5; row >= 0; row--) {
    let sum = a[row]![6]!;
    for (let k = row + 1; k < 6; k++) sum -= a[row]![k]! * x[k]!;
    x[row] = sum / a[row]![row]!;
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

// 推力の組が生む合力と合トルク。
export function wrenchOf(
  thrusters: readonly ThrusterSpec[],
  forces: readonly number[],
): { readonly force: Vec3; readonly torque: Vec3 } {
  let force = v3();
  let torque = v3();
  for (let i = 0; i < thrusters.length; i++) {
    const t = thrusters[i]!;
    const f = forces[i] ?? 0;
    if (!(f > 0)) continue;
    const vector = scale(t.direction, f);
    force = add(force, vector);
    torque = add(torque, cross(t.position, vector));
  }
  return { force, torque };
}

// 位置と噴射方向からスラスタ1基を作る。direction は正規化する。
export function thrusterSpec(position: Vec3, direction: Vec3, maxThrust: number): ThrusterSpec {
  return { position, direction: norm(direction), maxThrust };
}
