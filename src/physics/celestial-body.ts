// 天体1体を外から見たときの型。分類の札・姿勢・回転基準系と、時刻から状態を答える口を持つ。
// 運動をどう合成するか(解析暦と数値暦の切り替え、キャッシュ、ECI 原点の解決)には関与しない
// ので、天体の位置を問い合わせたいだけの側はこちらを受け取る。
import type { Quat } from '../math/quat';
import type { Vec3 } from '../math/vec3';
import type { Atmosphere } from './atmosphere';
import type { KinematicState } from './kinematic-state';

// 天体の分類。網羅的な分岐を書きたい呼び出し側のための札で、運動の合成そのものはクラスが担う。
export type CelestialKind = 'star' | 'planet' | 'satellite';

// 天体の自転軸(単位ベクトル、ECI)と、その軸まわりの自転位相 [rad]。
export interface BodyOrientation {
  readonly axis: Vec3;
  readonly spinAngle: number;
}

// 天体に固定した回転基準系の、ECI に対する姿勢 q と角速度 omega [rad/s](ECI 成分)。
// 回転軸が一定とは限らないので、軸と回転角の対ではなくこの対で扱う。
export type FrameRotation = { readonly q: Quat; readonly omega: Vec3 };

// 2次重力場の非軸対称成分(赤道断面の楕円性)を、ある時刻の姿勢へ解決した形。主軸座標系で
// 表すため S22 は恒等的に 0 になり、長軸の向きだけで姿勢が決まる。
interface TesseralGravity {
  readonly c22: number;
  readonly longAxis: Vec3; // 主軸座標系の長軸(単位ベクトル、ECI)
}

// 天体の2次(degree 2)の重力場を、ある時刻の姿勢へ解決した形。係数は非正規化。refRadius は
// 係数が定義された基準半径で、地形としての表面半径とは別の量。
export interface Degree2Gravity {
  readonly j2: number; // 極方向の扁平(= −C20)
  readonly refRadius: number; // [m]
  readonly pole: Vec3; // 自転軸(単位ベクトル、ECI)
  readonly tesseral: TesseralGravity | null; // null なら軸対称
}

// 時刻から自分1体ぶんの ECI 状態を答える天体。
export interface CelestialBody {
  readonly id: string;
  readonly kind: CelestialKind;
  // 重力定数 [m³/s²] と表面半径 [m]。どの天体も必ず持つ2つで、二体の幾何はこれだけで組める。
  readonly def: { readonly mu: number; readonly radius: number };
  // 主天体。惑星なら恒星、衛星ならその惑星、恒星自身は null。
  readonly primary: CelestialBody | null;
  // pivot で厳密に引いた値から時刻 t へ外挿した ECI 位置・速度。t を省くと pivot 自身の厳密な値。
  stateAt(pivot: number, t?: number): KinematicState;
  // 同じ外挿で位置だけを答える。
  positionAt(pivot: number, t?: number): Vec3;
  // pivot での大気。大気を持たない天体は null。
  atmosphereAt(pivot: number): Atmosphere | null;
  // pivot での2次重力場。質点として扱う天体は null。
  degree2At(pivot: number): Degree2Gravity | null;
  // 時刻 t の自転姿勢。自転モデルを持たない天体は null。
  orientationAt(t: number): BodyOrientation | null;
  // 時刻 t の自転に固定した回転基準系。自転モデルを持たない天体は null。
  spinRotationAt(t: number): FrameRotation | null;
  // 自転角速度 [rad/s]。逆行自転では負。自転モデルを持たない天体は null。
  readonly spinRate: number | null;
}

// 公転している天体。公転面と、それに乗る回転基準系を答える。
export interface OrbitingCelestialBody extends CelestialBody {
  orbitFrameRotationAt(t: number): FrameRotation;
  orbitNormalAt(t: number): Vec3;
}

// 暦の値をそのまま答える天体。ECI 化はこの値から組むので、原点と対象は必ず同じ経路どうしで
// 差を取る必要がある — どちらの経路で引けたかが分かる形で返す。
export interface EphemerisBody {
  readonly id: string;
  // 数値暦で引ける時刻の太陽系重心状態。収録外・有効期間外では null。
  numericStateAt(t: number): KinematicState<'numeric'> | null;
  // 解析暦による主星相対状態。いつでも答えられる。
  analyticStarRelStateAt(t: number): KinematicState<'starRel'>;
  // 解析暦による太陽系重心加速度 [m/s²]。
  analyticAccelAt(t: number): Vec3;
}
