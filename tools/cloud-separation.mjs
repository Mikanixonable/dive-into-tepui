// 実写の雲画像(輝度 0..1)を、生成側の層境界と同じ 3 チャンネル — 厚い雲の被覆率・雲頂高度・
// 薄い雲(巻雲) — へ推定分離する。高度の次元は原理的に欠けているので、巻雲の特徴だけに頼る:
//   - 局所的に等方な細かい起伏が無い: 積雲・層積雲の粒は全方向に細かいが、巻雲は滑らかか、
//     筋状(1 方向にだけ細かい)。方向依存は構造テンソルの固有値で測る — 小さい方の固有値
//     λ2 が「等方な細かさ」、(λ1−λ2)/(λ1+λ2) が「筋の度合い」。
// 分離は実写をスクリーン合成 photo = veil + thick·(1−veil) とみなした逆演算で行う。
//   1. veil の土台: 等方な細かさが弱い(=巻雲でありうる)画素に重みを付け、~窓 km の重み付き
//      下側パーセンタイルを取る。積雲場では晴れ間の床を、一様な薄い層ではその輝度を拾う。
//      床が天井を超える窓(厚い雲で覆われて床が見えない)は天井に張り付ける — 明るく厚い系の
//      上には巻雲の傘も掛かっているとみなし、超過分だけを厚い側へ渡す。粒ばかりで証拠が乏しい
//      窓だけ veil 0 に落とす。
//   2. 筋の成分: 筋状で暗い画素は、土台からはみ出た分も veil へ載せる(巻雲の筋そのもの)。
//   3. thick = (photo − veil)/(1 − veil)。
// 雲頂高度は thick から推定する: 広い濃さ(ぼかした thick)を土台に、細かい起伏を増幅して重ねる。
import { boxBlur } from './gray-image.mjs';

// 分離の調整パラメータ。長さはすべて km(図法・解像度に依らない)、輝度は 0..1、勾配は /100 km。
export const SEPARATION = {
  // 細かい起伏を測る尺度: 勾配を取る前のぼかし半径と、構造テンソルを均す窓の半径。
  fineScaleKm: 15,
  tensorWindowKm: 40,
  // 等方な細かい起伏(積雲の証拠)がこの値 [輝度²/(100km)²] に達した画素は veil の証拠にしない。
  isotropyThreshold: 0.06,
  // veil の土台: 下側パーセンタイルを取る窓の半径・とる分位・巻雲の輝度の天井・証拠の最低量
  // (重みの合計 / 標本数)・土台を均す半径。
  windowKm: 200,
  percentile: 0.45,
  ceiling: 0.40,
  credibleFractionMin: 0.05,
  smoothKm: 80,
  // 筋の成分: 筋とみなす輝度の上限(そこまでは満額、そこから幅 fade で 0 へ)と、載せる割合。
  // energyMin は筋に要求する細かい尺度の起伏 λ1 [輝度²/(100km)²] — 幅の広い滑らかな帯(前線)は
  // λ1 が小さいので筋に数えない(coherence は比なので、これが無いと滑らかな帯まで筋になる)。
  streakBrightnessMax: 0.45,
  streakBrightnessFade: 0.15,
  streakEnergyMin: 0.08,
  streakGain: 1.0,
  // 雲頂高度(0..1 = 0..15000 m): 底 + 広い濃さ(半径 topSmoothKm)× 利得 + 細かい起伏 × 増幅。
  topBase: 0.1,
  topSmoothKm: 150,
  topGain: 0.9,
  topRelief: 0.6,
  // veil の土台を求める粗い格子の刻み。
  gridStrideKm: 40,
};

// 構造テンソルの固有値と筋の度合い。kmPerPxAt(y) が返す物理スケールで勾配を /100 km に直すので、
// 正距円筒の横伸びは緯度ごとに補正される。返り値は { isotropy(=λ2), coherence } の 2 場。
function structureTensor(field, kmPerPxAt) {
  const { width, height } = field;
  const midKm = kmPerPxAt(Math.floor(height / 2)).y;
  const smooth = boxBlur(field, Math.max(1, Math.round(SEPARATION.fineScaleKm / midKm)), false);
  const gxx = { width, height, data: new Float32Array(width * height) };
  const gyy = { width, height, data: new Float32Array(width * height) };
  const gxy = { width, height, data: new Float32Array(width * height) };
  for (let y = 0; y < height; y++) {
    const km = kmPerPxAt(y);
    const scaleX = 100 / (2 * km.x);
    const scaleY = 100 / (2 * km.y);
    const y0 = Math.max(0, y - 1) * width;
    const y1 = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(width - 1, x + 1);
      const gx = (smooth.data[row + xp] - smooth.data[row + xm]) * scaleX;
      const gy = (smooth.data[y1 + x] - smooth.data[y0 + x]) * scaleY;
      gxx.data[row + x] = gx * gx;
      gyy.data[row + x] = gy * gy;
      gxy.data[row + x] = gx * gy;
    }
  }
  const radius = Math.max(1, Math.round(SEPARATION.tensorWindowKm / midKm));
  const jxx = boxBlur(gxx, radius, false);
  const jyy = boxBlur(gyy, radius, false);
  const jxy = boxBlur(gxy, radius, false);
  const isotropy = new Float32Array(width * height);
  const coherence = new Float32Array(width * height);
  const energy = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const mean = (jxx.data[i] + jyy.data[i]) / 2;
    const diff = Math.hypot((jxx.data[i] - jyy.data[i]) / 2, jxy.data[i]);
    isotropy[i] = mean - diff;
    coherence[i] = diff / (mean + 1e-6);
    energy[i] = mean + diff;
  }
  return {
    isotropy: { width, height, data: isotropy },
    coherence: { width, height, data: coherence },
    energy: { width, height, data: energy },
  };
}

// veil の土台: 重み weight 付きの下側パーセンタイルを粗い格子で取り、均して画素へ戻す。
function veilBase(field, weight, kmPerPxAt, wrapX) {
  const { width, height, data } = field;
  const midKm = kmPerPxAt(Math.floor(height / 2)).y;
  const stride = Math.max(2, Math.round(SEPARATION.gridStrideKm / midKm));
  const gw = Math.ceil(width / stride);
  const gh = Math.ceil(height / stride);
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const y = gy * stride;
    const km = kmPerPxAt(y);
    const ry = Math.max(2, Math.round(SEPARATION.windowKm / km.y));
    const rx = Math.max(2, Math.round(SEPARATION.windowKm / km.x));
    const sy = Math.max(1, Math.floor(ry / 6));
    const sx = Math.max(1, Math.floor(rx / 6));
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * stride;
      const samples = [];
      let count = 0;
      let total = 0;
      for (let dy = -ry; dy <= ry; dy += sy) {
        const yy = Math.min(height - 1, Math.max(0, y + dy));
        for (let dx = -rx; dx <= rx; dx += sx) {
          let xx = x + dx;
          if (wrapX) xx = (xx + width) % width;
          else xx = Math.min(width - 1, Math.max(0, xx));
          const w = weight.data[yy * width + xx];
          count++;
          if (w > 0) {
            samples.push([data[yy * width + xx], w]);
            total += w;
          }
        }
      }
      let veil = 0;
      if (total >= count * SEPARATION.credibleFractionMin) {
        samples.sort((a, b) => a[0] - b[0]);
        let cumulative = 0;
        let floor = samples[samples.length - 1][0];
        for (const [value, w] of samples) {
          cumulative += w;
          if (cumulative >= total * SEPARATION.percentile) {
            floor = value;
            break;
          }
        }
        veil = Math.min(floor, SEPARATION.ceiling);
      }
      grid[gy * gw + gx] = veil;
    }
  }
  const smoothRadius = Math.max(1, Math.round(SEPARATION.smoothKm / (midKm * stride)));
  const smoothed = boxBlur({ width: gw, height: gh, data: grid }, smoothRadius, wrapX);
  // 双一次で画素へ戻す。
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1.001, y / stride);
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1.001, x / stride);
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      out[y * width + x] =
        smoothed.data[y0 * gw + x0] * (1 - fx) * (1 - fy)
        + smoothed.data[y0 * gw + x0 + 1] * fx * (1 - fy)
        + smoothed.data[(y0 + 1) * gw + x0] * (1 - fx) * fy
        + smoothed.data[(y0 + 1) * gw + x0 + 1] * fx * fy;
    }
  }
  return { width, height, data: out };
}

// 実写(輝度 0..1)を厚い雲と巻雲へ分離する。kmPerPxAt(y) は行 y の 1 px が張る長さ
// { x, y } [km]、wrapX は経度の巻き付き。返り値の thick / veil は輝度、isotropy / coherence は
// 判定の材料(調整時の検分用)。
export function separateClouds(field, kmPerPxAt, wrapX) {
  const { width, height, data } = field;
  const tensor = structureTensor(field, kmPerPxAt);
  // veil の証拠の重み: 等方な細かさが無いほど 1 へ。
  const weight = {
    width,
    height,
    data: Float32Array.from(tensor.isotropy.data, (v) => Math.max(0, 1 - v / SEPARATION.isotropyThreshold)),
  };
  const base = veilBase(field, weight, kmPerPxAt, wrapX);
  const veil = new Float32Array(width * height);
  const thick = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = data[i];
    // 筋の成分: 筋状(coherence 高・等方な細かさ弱・細かい尺度の起伏あり)で暗い画素は、
    // 土台を超える分も巻雲。
    const streaky = tensor.coherence.data[i] * weight.data[i]
      * Math.min(1, tensor.energy.data[i] / SEPARATION.streakEnergyMin);
    const thin = Math.min(1, Math.max(
      0, (SEPARATION.streakBrightnessMax - p) / SEPARATION.streakBrightnessFade + 1));
    const streak = streaky * thin * Math.max(0, p - base.data[i]) * SEPARATION.streakGain;
    const v = Math.min(p, base.data[i] + streak);
    veil[i] = v;
    thick[i] = Math.min(1, Math.max(0, (p - v) / (1 - Math.min(0.98, v))));
  }
  return {
    thick: { width, height, data: thick },
    veil: { width, height, data: veil },
    isotropy: tensor.isotropy,
    coherence: tensor.coherence,
    energy: tensor.energy,
  };
}

// 厚い雲の輝度から雲頂高度(0..1 = 0..15000 m)を推定する。広い濃さを土台に、細かい起伏を
// 増幅して重ねる — 深い対流ほど高く、雲の中の凹凸がそのまま雲頂の凹凸になる近似。
export function estimateCloudTop(thick, kmPerPxAt, wrapX) {
  const midKm = kmPerPxAt(Math.floor(thick.height / 2)).y;
  const broad = boxBlur(thick, Math.max(1, Math.round(SEPARATION.topSmoothKm / midKm)), wrapX);
  const data = Float32Array.from(thick.data, (v, i) => Math.min(1, Math.max(
    0,
    SEPARATION.topBase + SEPARATION.topGain * broad.data[i] + SEPARATION.topRelief * (v - broad.data[i]))));
  return { width: thick.width, height: thick.height, data };
}
