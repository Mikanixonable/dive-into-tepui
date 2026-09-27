// 主推進器プルームの形状モデル。外気密度 [kg/m³] から、排気が満たす切頭円錐の広がり・
// 届く長さ・軸方向の減衰・径方向プロファイルの鋭さを決める。真空中の自由膨張(半角 40°
// 級の広い扇)から、海面密度で細く絞られた流れまで、外気密度の対数で連続に遷移する。

// 排気領域の形状パラメータ。軸距離 s(出口断面から [m])に対し半径は
// NOZZLE_EXIT_RADIUS + tanHalfAngle·s、径方向プロファイルは exp(−(r/半径)^radialExponent)。
export interface PlumeShape {
  // 円錐の半角の正接。軸方向に進むほど半径がこの割合で広がる。
  readonly tanHalfAngle: number;
  // 排気が届く領域の長さ [m]。
  readonly length: number;
  // 軸方向の密度減衰長 [m]。
  readonly decayLength: number;
  // 径方向プロファイル exp(−(r/σ)^p) の指数 p。真空側で縁の立った扇形、稠密側で
  // ガウス状の芯になる。
  readonly radialExponent: number;
}

// ノズルの出口半径 [m]。LE-9 を参考にした主ノズル(出口径 2〜3 m 級)からの推定。
export const PLUME_NOZZLE_EXIT_RADIUS = 1.0;

// 外気密度 → 形状遷移の対数スケールの端点 [kg/m³]。SATURATED は地球の海面密度で、ここで
// 形状が稠密側の端へ達する。TRANSITION は遷移が始まる希薄な外気の程度。
const SHAPE_TRANSITION_DENSITY = 1e-4;
const SHAPE_SATURATED_DENSITY = 1.2;

// 真空側の半角は排気の自由膨張の扇(~40°)、稠密側は外圧に絞られた流れ(4°)。
const VACUUM_TAN_HALF_ANGLE = Math.tan((40 * Math.PI) / 180);
const DENSE_TAN_HALF_ANGLE = Math.tan((4 * Math.PI) / 180);
// 排気が届く長さ [m]。真空側は密度が出口近傍に留まるため短い。
const VACUUM_LENGTH = 18;
const DENSE_LENGTH = 60;
// 軸方向の密度減衰長 [m]。
const VACUUM_DECAY_LENGTH = 3;
const DENSE_DECAY_LENGTH = 20;
// 径方向プロファイルの指数。真空の自由膨張は扇の縁が立つ(4乗)、稠密な流れは
// ガウス状の芯(2乗)。
const VACUUM_RADIAL_EXPONENT = 4;
const DENSE_RADIAL_EXPONENT = 2;

// 外気密度から形状パラメータを求める。密度は対数で遷移へ写す — 真空の0から海面の
// 1.2 kg/m³ までの桁の差を滑らかに繋ぐ。密度 0 は真空側の端、飽和密度以上は稠密側の端。
export function plumeShape(ambientDensity: number): PlumeShape {
  const density = Math.max(ambientDensity, 0);
  const weight = Math.min(
    Math.log1p(density / SHAPE_TRANSITION_DENSITY)
      / Math.log1p(SHAPE_SATURATED_DENSITY / SHAPE_TRANSITION_DENSITY),
    1,
  );
  const mix = (vacuum: number, dense: number): number => vacuum + (dense - vacuum) * weight;
  return {
    tanHalfAngle: mix(VACUUM_TAN_HALF_ANGLE, DENSE_TAN_HALF_ANGLE),
    length: mix(VACUUM_LENGTH, DENSE_LENGTH),
    decayLength: mix(VACUUM_DECAY_LENGTH, DENSE_DECAY_LENGTH),
    radialExponent: mix(VACUUM_RADIAL_EXPONENT, DENSE_RADIAL_EXPONENT),
  };
}
