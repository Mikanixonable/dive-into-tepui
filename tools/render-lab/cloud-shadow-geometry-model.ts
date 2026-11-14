// 雲影の幾何評価の共通モデル。合成の雲場の置き方(円板の位置・半径・雲頂高度・cap・画面へ
// 写す範囲)と、影の遠端・重心のずれの期待値の式を1か所に持つ。render-lab のケース
// (cloud-shadow-geometry-cases.ts)・評価(tools/cloud-shadow-geometry-check.mjs)・純粋な計算
// のテスト(tests/render/cloud-shadow-geometry.test.ts)が同じ数を読む。
//
// 幾何モデル: 受け手は半径 BODY_RADIUS_M の真球の地表。積雲の柱は「方向の円板」(中心の
// 天頂方向から角距離 δ = r/R まで、雲頂高度 H まで一様に満たされた殻)として扱う — 実機の
// レンダラが柱の光学的厚みを光路の稼いだ高度へ配分する規則の解析的な写像。
// 受け手の角位置 φ は円板の中心から恒星と反対向きへ測る(負なら恒星側)。
// 受け手 φ から恒星へ向かう光線が、地上角位置 β で張る高度は
//   h(β) = R * (sin(θ + φ) / sin(β + θ) - 1)   [m]
// (θ は円板中心での恒星の天頂角 [rad])。

// 受け手の天体の半径 [m]。地球と同じ。
export const BODY_RADIUS_M = 6371e3;
// 合成の殻の上端高度 [m]。ケースは CUMULUS_TOP_ALTITUDE(src/render/cloud/cloud-kind.ts)を渡し、
// この値と一致する前提 — 量→雲頂の写像がそのまま実高度になる。
export const TOP_ALTITUDE_M = 17000;
// 光路の上限 [m]。src/render/pipeline/shadow/cloud-shadow-renderer.ts の MAX_LIGHT_PATH。
export const MAX_LIGHT_PATH_M = 3e5;
// 細部タップの間隔 [m]。同じく FINE_STEP。タップ 1 歩が代表する幅の粒なので、測定側の
// 重心の許容差の絶対下限に使う。
export const FINE_STEP_M = 1.5e3;
// 細部が動かせる雲頂の幅 [m]。cloud-shape-evaluator.ts の DETAIL_TOP_RELIEF(0.15) ×
// DETAIL_AMPLITUDE_MAX(1) を実高度へ戻したもの。細部あり(dstd)の評価で、影の届きうる上限の
// 雲頂に使う。
export const DETAIL_TOP_RELIEF_M = 0.15 * TOP_ALTITUDE_M;
// 合成の雲場の 1 辺 [texel] と、cap が地表で張る半径 [m]。
export const FIELD_TEXELS = 1024;
export const CAP_GROUND_RADIUS_M = 220e3;
// 画素を地表の点へ写す矩形。x は恒星方位の実寸(恒星は +X 側、影は −X 側へ落ちる)、
// z はそれに直交する実寸、どちらも円板の中心からのずれ。
export const MAP = {
  // 影が遠くまで伸びる側(−x)へ窓を寄せる。x ∈ [centerX − width/2, centerX + width/2]。
  widthM: 400e3,
  centerXM: -100e3,
  heightM: 360e3,
} as const;
// 評価する恒星の天頂角 [deg](円板の直下点から見た値)。
export const ZENITH_DEG = [0, 30, 60, 75, 85] as const;
export interface GeometryDisc {
  readonly key: string;
  readonly xiM: number;
  readonly zetaM: number;
  readonly radiusM: number;
  readonly topAltitudeM: number;
}
// 円板の組。恒星側からはみ出さないよう ξ は 0 で揃え、z 方向へ列を分ける
// (列の間隔 40 km > 2r + 余白で、別の円板の影と交わらない)。
export const DISCS: readonly GeometryDisc[] = [
  { key: 'r3-h1p5', xiM: 0, zetaM: -20e3, radiusM: 3e3, topAltitudeM: 1.5e3 },
  { key: 'r3-h4', xiM: 0, zetaM: -60e3, radiusM: 3e3, topAltitudeM: 4e3 },
  { key: 'r3-h8', xiM: 0, zetaM: -100e3, radiusM: 3e3, topAltitudeM: 8e3 },
  { key: 'r3-h12', xiM: 0, zetaM: -140e3, radiusM: 3e3, topAltitudeM: 12e3 },
  { key: 'r10-h1p5', xiM: 0, zetaM: 20e3, radiusM: 10e3, topAltitudeM: 1.5e3 },
  { key: 'r10-h4', xiM: 0, zetaM: 60e3, radiusM: 10e3, topAltitudeM: 4e3 },
  { key: 'r10-h8', xiM: 0, zetaM: 100e3, radiusM: 10e3, topAltitudeM: 8e3 },
  { key: 'r10-h12', xiM: 0, zetaM: 140e3, radiusM: 10e3, topAltitudeM: 12e3 },
];

// 円板の角半径 [rad]。
const discAngle = (radiusM: number) => radiusM / BODY_RADIUS_M;
// 受け手 φ の光線が地上角位置 β で張る高度 [m]。φ・β・θ は rad。
const rayAltitudeM = (phi: number, beta: number, zenithRad: number) =>
  BODY_RADIUS_M * (Math.sin(zenithRad + phi) / Math.sin(beta + zenithRad) - 1);

// 遠端の角位置。光線が円板の反恒星側の上端の角(β = +δ, h = H)をかする受け手。
// 式: 光線の直線が円板上端の角を通る条件から R sin(θ+φ) = (R+H) sin(θ+δ)。
const geoFarAngle = (radiusM: number, topAltitudeM: number, zenithRad: number) => {
  const arg = (1 + topAltitudeM / BODY_RADIUS_M) * Math.sin(zenithRad + discAngle(radiusM));
  // 引数が 1 を越えると、光線は上端の角へ届く前に天頂へ抜けて遠端が無い — 地平の制約へ畳む。
  return Math.asin(Math.min(1, arg)) - zenithRad;
};

// 光路の上限が張る遠端の角位置。受け手から円板の上端の角までの距離が MAX_LIGHT_PATH に
// 達する受け手を返す(残弦の公式 |A−Q|² = R² + (R+H)² − 2R(R+H) cos(φ−δ))。
const pathFarAngle = (radiusM: number, topAltitudeM: number) => {
  const r = BODY_RADIUS_M;
  const h = r + topAltitudeM;
  const cos = (r * r + h * h - MAX_LIGHT_PATH_M * MAX_LIGHT_PATH_M) / (2 * r * h);
  return discAngle(radiusM) + Math.acos(Math.max(-1, Math.min(1, cos)));
};

// 遠端の角位置 [rad]。幾何の上端・光路の上限・恒星が地平線へ沈む制約のうち最も小さいもの。
export function farEdgeAngle(radiusM: number, topAltitudeM: number, zenithRad: number) {
  const horizon = Math.PI / 2 - zenithRad;
  return Math.min(geoFarAngle(radiusM, topAltitudeM, zenithRad),
    pathFarAngle(radiusM, topAltitudeM), horizon);
}

// 影の遠端の、円板の中心からの地表距離 [m](反恒星向き)。
export function expectedFarEdgeM(radiusM: number, topAltitudeM: number, zenithRad: number) {
  return Math.max(0, farEdgeAngle(radiusM, topAltitudeM, zenithRad)) * BODY_RADIUS_M;
}

// 合成の円板の鉛直柱光学深さ。量→高度の写像は src/render/cloud/cloud-kind.ts の
// cumulusAmountFromTopAltitude / cumulusColumnOpticalDepth と同じ式(CPU の基準が src の
// 関数なので、評価側ではここへ写して持つ)。
export function cumulusAmountForTopAltitudeM(topAltitudeM: number) {
  const t = Math.min(Math.max((topAltitudeM - 500) / 16500, 0), 1);
  return Math.sqrt(t);
}
const columnOpticalDepthForTopAltitudeM = (topAltitudeM: number) =>
  cumulusAmountForTopAltitudeM(topAltitudeM) / 0.12;

// 受け手 φ の光線が円板の柱の内側で稼ぐ高度 [m]。柱を上まで抜くと H、横から斜めに抜ける
// と入口と出口の差になる。光線が掃引する地上角位置の範囲は、受け手の角 φ から光線の向きが
// 無限遠で漸近する角 −θ まで — その範囲と柱の方向範囲 [−δ, δ] が交わる区間で、光線の高度が
// [0, H] に収まる分が柱の内側。
function columnRiseM(phi: number, radiusM: number, topAltitudeM: number, zenithRad: number) {
  const d = discAngle(radiusM);
  const lo = Math.min(phi, -zenithRad), hi = Math.max(phi, -zenithRad);
  // 光線が柱の方向区間と交わる両端。
  const betaIn = Math.max(lo, -d), betaOut = Math.min(hi, d);
  if (betaIn >= betaOut) return 0;
  // β = −θ は光線が高度 ∞ へ漸近する角で、式の分母が 0 になる。
  const altitudeAt = (beta: number) =>
    (beta === -zenithRad ? Infinity : rayAltitudeM(phi, beta, zenithRad));
  const hLo = Math.min(altitudeAt(betaIn), altitudeAt(betaOut));
  const hHi = Math.max(altitudeAt(betaIn), altitudeAt(betaOut));
  return Math.max(0, Math.min(topAltitudeM, hHi) - Math.min(topAltitudeM, Math.max(0, hLo)));
}

// 重心のずれの期待値。柱を抜ける高さに応じて 1 − exp(−τ·割合) だけ暗くなるので、
// 暗さの重み付き重心を柱の内外へ積分する(台形ではなく中点)。
export function expectedCentroidOffsetM(radiusM: number, topAltitudeM: number, zenithRad: number) {
  const far = farEdgeAngle(radiusM, topAltitudeM, zenithRad);
  const d = discAngle(radiusM);
  if (far <= -d) return 0;
  const tau = columnOpticalDepthForTopAltitudeM(topAltitudeM);
  const steps = 4096;
  // 恒星側にも柱の錐の裾ぶんの影が落ちうるので、対称な遠端まで積む(寄与が無い所は 0 で
  // 捨てられる)。
  const lo = -far, hi = far;
  let sumW = 0, sumPhiW = 0;
  for (let i = 0; i < steps; i++) {
    const phi = lo + (i + 0.5) * (hi - lo) / steps;
    const rise = columnRiseM(phi, radiusM, topAltitudeM, zenithRad);
    if (rise <= 0) continue;
    const w = 1 - Math.exp(-tau * rise / topAltitudeM);
    // 測定側と同じく、8bit 量子化の滲み(2% 未満の暗さ)は重みに載せない。
    if (w < 0.02) continue;
    sumW += w;
    sumPhiW += phi * w;
  }
  if (sumW === 0) return 0;
  return (sumPhiW / sumW) * BODY_RADIUS_M;
}

// 影の最深部の透過率の期待値。円板の下では柱を上まで抜くので exp(−τ)。実機の不透明度の
// 飽和(MAX_COLUMN_OPACITY = 0.99 → τ ≈ 4.6)が効く量ではそちらへ頭打ちする。
export function expectedMinTransmittance(topAltitudeM: number) {
  const tau = Math.min(columnOpticalDepthForTopAltitudeM(topAltitudeM), -Math.log(1 - 0.99));
  return Math.exp(-tau);
}
