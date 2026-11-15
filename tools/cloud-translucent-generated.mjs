// 生成側の半透明雲の窓の組み立てに使う純粋な計算。cloud-lab の translucent ページが
// 返した物理量の画素から、教師と同じ条件の半透明高層雲のマスク・深い対流の芯・
// 型の振り分けを導く。compare(ブラウザ駆動)と selftest(合成場)の両方がこれを通る。
import {
  TRANSLUCENT_CTH_MIN_M, TRANSLUCENT_COT_RANGE, classifyPattern, quantileOfSorted,
} from './cloud-translucent-features.mjs';
import { dilateMask, labelMask, translateMask } from './cloud-translucent-gibs.mjs';

// ページの RGBA8 の符号化の分母。ページ側は描画器と同じ式の上限で正規化して送る
// (src/render/cloud/cloud-kind.ts の CUMULUS_MAX_OPTICAL_DEPTH = 1/0.12、
// CIRRUS_MAX_OPTICAL_DEPTH = 3、CUMULUS_TOP_ALTITUDE = 17000、CIRRUS_TOP_ALTITUDE = 13000)。
export const PHYS_SPAN = {
  cumulusTau: 1 / 0.12,
  cirrusTau: 3,
  cumulusTop: 17000,
  cirrusTop: 13000,
};
// ページの風の符号化が張る速さ [m/s](tools/cloud-lab/motion-main.ts の WIND_SPAN_MS と同じ)。
export const WIND_SPAN_MS = 96;

// 深い対流の芯の条件。不透明(0.9 以上 → 光学深さ ln(10) 以上)かつ雲頂が −48 ℃ の
// 輝度温度に届く積雲(教師の帯 13 の −48 ℃ と同じ高さの意味)。地表温度は緯度だけの
// 推定(motion-main.ts と同じく赤道 299 K・極 277 K、cos²lat で繋ぐ)から 6.5 K/km で下る。
const CORE_MIN_TAU = Math.log(10);
const CORE_BT_K = 273.15 - 48;
const LAPSE_K_PER_M = 0.0065;
// 芯と数える連結領域の最小面積 [km²](教師と同じ 50 km²)。
const CORE_MIN_AREA_KM2 = 50;
// anvil の関連半径 [km](教師と同じ 60 km)。
export const ANVIL_RADIUS_KM = 60;
// remnant の採用に要る、移流した芯との窓内の重なり(教師と同じ 0.1)。
export const REMNANT_OVERLAP_MIN = 0.1;
// 移流した芯の位置決めの余裕 [km](教師と同じ 80 km)と、遡る時差 [h]。
export const ADVECT_DILATE_KM = 80;
const ADVECT_LAG_H = 2;
// 抽出で各区分の窓に要る半透明高層雲の割合(教師の EXTRACT_TRANSLUCENT_MIN と同じ)。
const EXTRACT_TRANSLUCENT_MIN = { streak: 0.15, scaly: 0.05, veil: 0.55, default: 0.05 };

// ページが返す RGBA8 base64 を生の画素へ。
export function decodeRgba8(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// RGBA8(R 積雲 τ・G 巻雲 τ・B 積雲雲頂・A 巻雲雲頂、それぞれ PHYS_SPAN で正規化)を
// 物理量の 4 場へ戻す。n は一辺の画素数。
export function decodePhysPixels(base64, n) {
  const rgba = decodeRgba8(base64);
  const cumTau = new Float32Array(n * n);
  const cirTau = new Float32Array(n * n);
  const cumTop = new Float32Array(n * n);
  const cirTop = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    cumTau[i] = (rgba[i * 4] / 255) * PHYS_SPAN.cumulusTau;
    cirTau[i] = (rgba[i * 4 + 1] / 255) * PHYS_SPAN.cirrusTau;
    cumTop[i] = (rgba[i * 4 + 2] / 255) * PHYS_SPAN.cumulusTop;
    cirTop[i] = (rgba[i * 4 + 3] / 255) * PHYS_SPAN.cirrusTop;
  }
  return { cumTau, cirTau, cumTop, cirTop };
}

// RGBA8(R・G = 地表付近、B・A = 上層の東・北成分 ±WIND_SPAN_MS)を m/s の 2 組の場へ。
export function decodeWindPixels(base64, n) {
  const rgba = decodeRgba8(base64);
  const surfaceEast = new Float32Array(n * n);
  const surfaceNorth = new Float32Array(n * n);
  const upperEast = new Float32Array(n * n);
  const upperNorth = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    surfaceEast[i] = (rgba[i * 4] / 255 - 0.5) * 2 * WIND_SPAN_MS;
    surfaceNorth[i] = (rgba[i * 4 + 1] / 255 - 0.5) * 2 * WIND_SPAN_MS;
    upperEast[i] = (rgba[i * 4 + 2] / 255 - 0.5) * 2 * WIND_SPAN_MS;
    upperNorth[i] = (rgba[i * 4 + 3] / 255 - 0.5) * 2 * WIND_SPAN_MS;
  }
  return { surfaceEast, surfaceNorth, upperEast, upperNorth };
}

// 積雲・巻雲の 2 層を 1 本の場へ畳む。教師の COT・雲頂に対応する量として、
// COT 相当 = τ_cum + τ_cir(光学的厚みは加算)、雲頂相当 = 光学的厚みで重み付けた
// 上側の雲頂(τ が 0 の画素は有限値を持たない実写の欠測と同じ扱いへ NaN)。
export function combinedOptics(phys, n) {
  const cot = new Float32Array(n * n);
  const cth = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const tau = phys.cumTau[i] + phys.cirTau[i];
    cot[i] = tau;
    cth[i] = tau > 0
      ? (phys.cumTau[i] * phys.cumTop[i] + phys.cirTau[i] * phys.cirTop[i]) / tau
      : NaN;
  }
  return { cot, cth };
}

// 教師と同じ条件の半透明高層雲のマスク(cth > TRANSLUCENT_CTH_MIN_M かつ
// TRANSLUCENT_COT_RANGE の内側)。cotValues はマスク画素の COT(中央値用)。
export function translucentMask(cot, cth, n) {
  const mask = new Uint8Array(n * n);
  const cotValues = [];
  for (let i = 0; i < n * n; i++) {
    const c = cot[i];
    const h = cth[i];
    if (Number.isFinite(c) && Number.isFinite(h)
      && h > TRANSLUCENT_CTH_MIN_M && c >= TRANSLUCENT_COT_RANGE[0] && c < TRANSLUCENT_COT_RANGE[1]) {
      mask[i] = 1;
      cotValues.push(c);
    }
  }
  return { mask, share: cotValues.length / (n * n), cotValues };
}

// 緯度 latitudeDeg [deg] で、雲頂が −48 ℃ の輝度温度に届く高さ [m]。地表温度の
// 緯度だけの推定(赤道 299 K・極 277 K)から 6.5 K/km で下った点。
export function coreHeightM(latitudeDeg) {
  const t = Math.cos((latitudeDeg * Math.PI) / 180) ** 2;
  const surfaceK = 277 + 22 * t;
  return (surfaceK - CORE_BT_K) / LAPSE_K_PER_M;
}

// 深い対流の芯のマスク。不透明(τ ≥ ln(10))かつ雲頂が coreHeightM 以上の積雲のうち、
// 面積 CORE_MIN_AREA_KM2 以上の連結領域だけを残す(教師の −48 ℃・50 km² と同じ)。
export function deepCoreMask(cumTau, cumTop, n, latitudeDeg, kmPerPx) {
  const height = coreHeightM(latitudeDeg);
  const rough = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    if (cumTau[i] >= CORE_MIN_TAU && cumTop[i] >= height) rough[i] = 1;
  }
  const labels = labelMask(rough, n, n);
  const mask = new Uint8Array(n * n);
  let count = 0;
  let largestAreaKm2 = 0;
  for (let c = 0; c < labels.sizes.length; c++) {
    const areaKm2 = labels.sizes[c] * kmPerPx * kmPerPx;
    if (areaKm2 < CORE_MIN_AREA_KM2) continue;
    count++;
    if (areaKm2 > largestAreaKm2) largestAreaKm2 = areaKm2;
    for (let i = 0; i < n * n; i++) if (labels.labels[i] === c) mask[i] = 1;
  }
  return { mask, count, largestAreaKm2 };
}

// 上層風で lagH 時間さかのぼった芯の位置。窓内の雲を作った芯は風上にあった —
// 画像座標は x=東・y=南なので、芯の過去位置は dx=−uE・dy=+uN 方向へ lagH 分ずらす。
// ずらした芯を ADVECT_DILATE_KM/kmPerPx 画素だけ膨らませる(位置決めの余裕)。
export function advectedCoreMask(coreMask, n, kmPerPx, windEastMs, windNorthMs, lagH = ADVECT_LAG_H) {
  const dxPx = Math.round((-windEastMs * lagH * 3600) / (kmPerPx * 1000));
  const dyPx = Math.round((windNorthMs * lagH * 3600) / (kmPerPx * 1000));
  const shifted = translateMask(coreMask, n, n, dxPx, dyPx);
  return dilateMask(shifted, n, n, Math.max(1, Math.round(ADVECT_DILATE_KM / kmPerPx)));
}

// 2 つのマスクの重なりの窓内占有率(AND の画素数 / n²)。
export function overlapShare(a, b, n) {
  let count = 0;
  for (let i = 0; i < n * n; i++) if (a[i] === 1 && b[i] === 1) count++;
  return count / (n * n);
}

// 窓内の上層風の平均ベクトルから、風が向かう方位 [deg](北 = 0・東 = 90。教師の
// advection で測る移動方向と同じ取り方)。mask は優先する画素(無ければ窓全体)。
// 平均風速が MIN_MEAN_MS 未満なら向きは測れない → null。
export function windDegOf(upperEast, upperNorth, n, mask = null, minMeanMs = 1) {
  let uE = 0;
  let uN = 0;
  let count = 0;
  for (let i = 0; i < n * n; i++) {
    if (mask !== null && mask[i] !== 1) continue;
    uE += upperEast[i];
    uN += upperNorth[i];
    count++;
  }
  if (count === 0) return null;
  uE /= count;
  uN /= count;
  if (Math.hypot(uE, uN) < minMeanMs) return null;
  return ((Math.atan2(uE, uN) * 180) / Math.PI + 360) % 360;
}

// 教師の窓の決め方と同じ順序で、生成側の窓を区分へ振る。先に芯との関係で拾う
// 対流系(anvil = 芯の 60 km 内、remnant = 芯が窓外で移流した芯との重なり)、
// 孤立系は判定関数(classifyPattern)へ。share は半透明高層雲の占有率。
export function classifyGeneratedWindow({
  share, anvilNear, coreInWindow, remnantOverlap, measured,
}) {
  if (share < (EXTRACT_TRANSLUCENT_MIN.default)) {
    return { className: 'clear', rule: 'translucent-share', classifiedAs: null };
  }
  if (anvilNear) return { className: 'anvil-active', rule: 'core-near', classifiedAs: null };
  if (!coreInWindow && remnantOverlap >= REMNANT_OVERLAP_MIN) {
    return { className: 'convective-remnant', rule: 'advected-core', classifiedAs: null };
  }
  const classified = classifyPattern(measured);
  if (classified.className === null) {
    return { className: 'unclassified', rule: 'unclassified', classifiedAs: null, values: classified.values };
  }
  const minShare = EXTRACT_TRANSLUCENT_MIN[classified.className] ?? EXTRACT_TRANSLUCENT_MIN.default;
  if (share < minShare) {
    return { className: 'clear', rule: `translucent-share(${classified.className})`, classifiedAs: classified.className };
  }
  return { className: classified.className, rule: 'pattern', classifiedAs: classified.className };
}

// マスク内 COT の中央値(教師の quantiles.cotP50 と同じ取り方)。
export function cotP50Of(cotValues) {
  if (cotValues.length === 0) return null;
  return quantileOfSorted([...cotValues].sort((a, b) => a - b), 0.5);
}
