// 天体1体の静的な記述。恒星・惑星・衛星それぞれの宣言と、その部品(自転極モデル・
// 2次重力場・形状・環系)、および宣言を simTime 基準へ畳む変換。
import { JULIAN_CENTURY, KeplerOrbit, keplerOrbitForSimZero } from './kepler-orbit';
import { SatelliteOrbit, satelliteOrbitForSimZero } from './satellite-orbit';
import { SECONDS_PER_DAY } from './time';
import { Vec3, v3 } from '../math/vec3';
import type { AtmosphereDef } from './atmosphere';

// 自転軸と自転位相の決め方。'eciPole' は ECI の極軸そのもの(この座標系を定義している天体)で、
// 自転角速度 spinRate [rad/s] をその天体が与える。'cassini' は同期回転する衛星のカッシーニ状態で、
// 黄道に対する赤道の傾き obliquity [rad] と軌道面法線から軸が、親を向き続ける平均黄経方向から
// 位相が決まる。'iau' は極の赤経・赤緯と自転位相 W をそれぞれ時刻の一次式で与える(周期項・
// 高次項は扱わない)。'iau' の係数はいずれも NAIF pck00011.tpc(WGCCRE 2015 準拠)の
// BODY_POLE_RA / BODY_POLE_DEC / BODY_PM。
export type PoleModel =
  | { readonly kind: 'eciPole'; readonly spinRate: number }
  | { readonly kind: 'cassini'; readonly obliquity: number }
  | {
      readonly kind: 'iau';
      readonly ra0Deg: number;
      readonly ra1DegPerCentury: number;
      readonly dec0Deg: number;
      readonly dec1DegPerCentury: number;
      readonly w0Deg: number;
      readonly wRateDegPerDay: number;
    };

// IAU モデルの元期を simZeroEt ぶん進めた自転モデル。基準方向・本初子午線の位相はどちらも
// 時刻の一次式なので係数へ畳める。極方向を持たないモデル(cassini/eciPole)は時刻の原点を
// 持たないのでそのまま。
function poleModelForSimZero(pole: PoleModel | undefined, simZeroEt: number): PoleModel | undefined {
  if (pole === undefined || pole.kind !== 'iau') return pole;
  const centuries = simZeroEt / JULIAN_CENTURY;
  const days = simZeroEt / SECONDS_PER_DAY;
  return {
    ...pole,
    ra0Deg: pole.ra0Deg + pole.ra1DegPerCentury * centuries,
    dec0Deg: pole.dec0Deg + pole.dec1DegPerCentury * centuries,
    // 本初子午線は1日1周規模で進むので、畳まないと 1e7 deg まで積み上がる。
    w0Deg: wrapDegrees(pole.w0Deg + pole.wRateDegPerDay * days),
  };
}

// 角度[deg]を [0, 360) へ畳む。
function wrapDegrees(x: number): number {
  return x - 360 * Math.floor(x / 360);
}

// 2次の重力場の静的な記述。
export interface Degree2GravityDef {
  readonly j2: number;
  readonly c22: number; // 0 なら軸対称
  readonly refRadius: number; // 係数が定義された基準半径 [m]
}

// 天体の形状(歪み)。省略時は `radius` による真球。'spheroid' は回転楕円体(赤道半径=極半径
// の2値)、'triaxial' は三軸楕円体(a >= b >= c、a が最長の赤道軸、b が残りの赤道軸、
// c が最短の極軸)。出典は pck00011.tpc の BODY_RADII。値はいずれも半径 [m](直径ではない)
// — pck/SBDB の `extent` は直径で載ることが多いので登録時に 2 で割ること。
export type ShapeDef =
  | { readonly kind: 'spheroid'; readonly equatorRadius: number; readonly polarRadius: number }
  | { readonly kind: 'triaxial'; readonly a: number; readonly b: number; readonly c: number };

// 環の光学特性。normalOpticalDepth は環面に垂直な消散光学的厚さ(可視光の代表値。各帯の出典と
// 近似範囲は登録側のコメントが持つ)。
export interface RingOpticsDef {
  readonly normalOpticalDepth: number;
  readonly singleScatteringAlbedo: number;
  readonly phaseG: number;
  readonly volumetric?: { readonly radialScale: number; readonly verticalScale: number };
}

// 環の弧。区間 [fromDeg, toDeg] の光学的厚さに掛ける倍率。
export interface RingArcDef {
  readonly fromDeg: number;
  readonly toDeg: number;
  readonly opticalDepthScale: number;
}
// 環の帯 1 本。
export interface RingBandDef {
  readonly innerRadius: number; // [m]
  readonly outerRadius: number; // [m]
  readonly thickness: number; // [m]
  readonly optics: RingOpticsDef;
  readonly arcs?: readonly RingArcDef[];
}
export interface RingSystemDef {
  readonly bands: readonly RingBandDef[];
}

// ShapeDef を天体固定座標の半軸 (x, y, z) [m] へ直す。y が自転軸(極半径)、x・z が赤道面の半軸で、
// 三軸楕円体では x が最長軸。shape 省略時は `radius` による真球。
export function shapeAxes(radius: number, shape: ShapeDef | undefined): Vec3 {
  if (shape === undefined) return v3(radius, radius, radius);
  if (shape.kind === 'spheroid') return v3(shape.equatorRadius, shape.polarRadius, shape.equatorRadius);
  return v3(shape.a, shape.c, shape.b);
}

// ShapeDef の楕円体に内接する最大の球の半径 [m](最短の半軸)。shape 省略時は radius。
export function shapeInscribedRadius(radius: number, shape: ShapeDef | undefined): number {
  const axes = shapeAxes(radius, shape);
  return Math.min(axes.x, axes.y, axes.z);
}

// ShapeDef を自転軸まわりの回転楕円体の半径 [m] へ丸める。三軸楕円体では短いほうの赤道軸を
// 赤道半径に採り、元の形に内接する側へ丸める。
export function shapeSpheroidRadii(
  radius: number, shape: ShapeDef | undefined,
): { readonly equatorRadius: number; readonly polarRadius: number } {
  const axes = shapeAxes(radius, shape);
  return { equatorRadius: Math.min(axes.x, axes.z), polarRadius: axes.y };
}

// 天体ごとの平均黄経の初期位相 [rad]。未指定の天体は 0 として扱う。
export type PhaseOffsets = Partial<Record<string, number>>;

export interface StarDef {
  readonly id: string;
  readonly mu: number;
  readonly radius: number;
}
export interface PlanetDef {
  readonly id: string;
  readonly mu: number;
  readonly radius: number;
  readonly orbit: KeplerOrbit; // 中心は必ず恒星で、乗っているのは惑星本体ではなく惑星-衛星系の重心
  readonly pole?: PoleModel; // 省略時は自転軸を持たない
  readonly degree2?: Degree2GravityDef; // 省略時は質点として扱う
  readonly shape?: ShapeDef; // 省略時は radius による真球
  readonly atmosphere?: AtmosphereDef; // 省略時は大気を持たない(抗力・焼失ともに起きない)
  readonly rings?: RingSystemDef; // 省略時は環を持たない
  // ラグランジュ点をフォーカス対象のラベルとして出すかどうか(省略時 = 出さない)。全公転天体で
  // 出すと 5 点 × 天体数のラベルが画面を埋めるので、実際に軌道設計の目標になる系だけを立てる。
  readonly lagrangeLabels?: boolean;
}
// 中心は必ず惑星で、その関係は SatelliteMotion が持つ参照が表す。
export type SatelliteDef = Omit<PlanetDef, 'orbit'> & { readonly orbit: SatelliteOrbit };
export type CelestialBodyDef = StarDef | PlanetDef | SatelliteDef;

// 天体の形(歪み)。恒星は形を持たず、`radius` による真球として扱う。
export function shapeOf(def: CelestialBodyDef): ShapeDef | undefined {
  return 'shape' in def ? def.shape : undefined;
}

// pole 定義から自転角速度 [rad/s] を取り出す。自転モデルを持たない天体は null。符号は自転の
// 向きを表し、逆行自転する天体では負になる。同期回転の衛星は本初子午線が公転の平均黄経を追うので、
// 自転角速度は公転の平均運動と一致する。歳差は自転の 10⁻⁷ 倍未満なので織り込まない。
export function spinRateOf(def: CelestialBodyDef): number | null {
  if (!('pole' in def)) return null;
  const pole = def.pole;
  if (pole === undefined) return null;
  if (pole.kind === 'eciPole') return pole.spinRate;
  if (pole.kind === 'iau') return (pole.wRateDegPerDay * Math.PI) / 180 / 86400;
  // カッシーニ状態の同期回転は衛星だけが持つ。
  return 'kepler' in def.orbit ? def.orbit.kepler.lRate : null;
}

// 天体の宣言を、平均黄経の初期位相と元期オフセットを畳み込んだ宣言へ写す。これを通した宣言
// だけが CelestialMotion へ渡ってよい — 軌道も自転モデルも simTime そのものを引数に取る形に
// なり、評価のたびに巨大な定数を足し直さずに済む。
export function planetDefForSimZero(def: PlanetDef, phases: PhaseOffsets, simZeroEt: number): PlanetDef {
  return {
    ...def,
    orbit: keplerOrbitForSimZero(def.orbit, phases[def.id] ?? 0, simZeroEt),
    pole: poleModelForSimZero(def.pole, simZeroEt),
  };
}

// 衛星の宣言を、同じ規約で simTime 基準の宣言へ写す。
export function satelliteDefForSimZero(
  def: SatelliteDef, phases: PhaseOffsets, simZeroEt: number,
): SatelliteDef {
  return {
    ...def,
    orbit: satelliteOrbitForSimZero(def.orbit, phases[def.id] ?? 0, simZeroEt),
    pole: poleModelForSimZero(def.pole, simZeroEt),
  };
}
