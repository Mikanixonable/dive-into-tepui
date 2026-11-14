// 雲の細部の画像へ物差しを当てる配管。線形輝度の場から measureCloudDetail と階調統計を取り、
// 封筒・分布の比較が使う特徴量の一覧(家族つき、log 領域へ写した値)へ畳む。
import { centerCrop, linearLuminanceField } from './cloud-detail-field.mjs';
import { measureCloudDetail } from './cloud-detail-metrics.mjs';

// 局所コントラストを取る窓の一辺 [km]。画素へ直すとき下限 2 px を置く。
const CONTRAST_WINDOW_KM = 4;

// 特徴量の定義。id の接頭語 → 家族・値の集め方・正規化前の領域。
// scope 'band' は尺度の帯(オクターブ番号 j、帯 [2^j, 2^(j+1)] km)ごと、'scale' は
// 構造テンソルの名目的な尺度 [km] ごと、'tier' は段の km/px ごとに封筒を組む。
// domain 'log' は封筒と距離を log10 の値で取る(桁をまたぐ量のため)。
const FEATURE_DEFS = {
  power: { family: 'spectrum', scope: 'band', domain: 'log' },
  slope: { family: 'spectrum', scope: 'band', domain: 'linear' },
  kurtosis: { family: 'intermittency', scope: 'band', domain: 'linear' },
  energyCv: { family: 'intermittency', scope: 'band', domain: 'linear' },
  anisoCoherence: { family: 'anisotropy', scope: 'scale', domain: 'linear' },
  anisoR: { family: 'anisotropy', scope: 'scale', domain: 'linear' },
  beta: { family: 'spectrum', scope: 'tier', domain: 'linear' },
  excess: { family: 'periodicity', scope: 'tier', domain: 'log' },
  fitSlope: { family: 'periodicity', scope: 'tier', domain: 'linear' },
  hetI: { family: 'heterogeneity', scope: 'scale', domain: 'log' },
  hetSlope: { family: 'heterogeneity', scope: 'tier', domain: 'linear' },
  hetClear: { family: 'heterogeneity', scope: 'tier', domain: 'linear' },
  hetDense: { family: 'heterogeneity', scope: 'tier', domain: 'linear' },
  b: { family: 'shapes', scope: 'tier', domain: 'linear' },
  D: { family: 'shapes', scope: 'tier', domain: 'linear' },
  cloudyShare: { family: 'shapes', scope: 'tier', domain: 'linear' },
  cloudCount: { family: 'shapes', scope: 'tier', domain: 'log' },
  toneMean: { family: 'tone', scope: 'tier', domain: 'linear' },
  toneP50: { family: 'tone', scope: 'tier', domain: 'linear' },
  toneP90: { family: 'tone', scope: 'tier', domain: 'linear' },
  toneP99: { family: 'tone', scope: 'tier', domain: 'linear' },
};

// 線形輝度の場の階調。平均と分位。
export function toneStats(data) {
  const sorted = Float64Array.from(data).sort();
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  let sum = 0;
  for (const v of data) sum += v;
  return { mean: sum / data.length, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}

// 一辺 CONTRAST_WINDOW_KM の窓の標準偏差の全画素平均。窓は px へ直す(下限 2 px 分の半径)。
// 場面どうしのばらつき(variety)のもとになる局所統計。
export function localContrast(field, kmPerPx) {
  const { width, height, data } = field;
  const radius = Math.max(1, Math.round(CONTRAST_WINDOW_KM / kmPerPx / 2));
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sumSquared = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      const i = (y + 1) * stride + (x + 1);
      sum[i] = v + sum[i - 1] + sum[i - stride] - sum[i - stride - 1];
      sumSquared[i] = v * v + sumSquared[i - 1] + sumSquared[i - stride] - sumSquared[i - stride - 1];
    }
  }
  const boxSum = (table, x0, y0, x1, y1) => table[(y1 + 1) * stride + x1 + 1] - table[y0 * stride + x1 + 1]
    - table[(y1 + 1) * stride + x0] + table[y0 * stride + x0];
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const y0 = Math.max(0, y - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y1 = Math.min(height - 1, y + radius);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = boxSum(sum, x0, y0, x1, y1) / count;
      const variance = boxSum(sumSquared, x0, y0, x1, y1) / count - mean * mean;
      total += Math.sqrt(Math.max(variance, 0));
    }
  }
  return total / data.length;
}

// ニュートラルトーンマップ(Khronos PBR Neutral)の圧縮開始点と、彩度床として全チャネルから
// 引かれる量。描画パイプラインの表示変換と同じ値 — ずれると換算後の反射率が系統的にずれる。
const NEUTRAL_COMPRESSION_START = 0.76;
const NEUTRAL_DESATURATION_FLOOR = 0.04;
// トーンマップは 1 へ漸近するので、その近傍では逆写像が発散する。8bit の量子化を増幅して
// 分位を壊さないよう、逆変換へ渡す表示値はこの値で頭打ちにする。
const NEUTRAL_INVERSE_INPUT_MAX = 0.98;

// 表示用の輝度を、トーンマップ前の放射輝度相当へ戻す。圧縮域は解析的に逆へ写し、床ぶんを
// 加えて戻す。床の実際の深さは画素の最小チャネルで決まるが、輝度では各画素自身を最小
// チャネルとみなす近似で戻す — 白に近い雲頂では誤差が小さい。単調なので、分位点で
// 閾値を取る特徴量(形状・被覆率)にはこの変換を掛けても結果が変わらない。
function invertNeutralDisplay(value) {
  const s = NEUTRAL_COMPRESSION_START;
  const d = 1 - s;
  const peak = value > s
    ? (s - d) + (d * d) / (1 - Math.min(value, NEUTRAL_INVERSE_INPUT_MAX))
    : value;
  return peak >= NEUTRAL_DESATURATION_FLOOR ? peak + NEUTRAL_DESATURATION_FLOOR : Math.sqrt(peak / 6.25);
}

// 1 画像の測定値から、封筒・距離に使う特徴量の一覧を組む。
// 各要素は { id, family, scope, key, value } — id は接頭語@帯・尺度。value は
// domain 'log' のものを log10 へ写した後の値。null・非正の log は載せない。
export function featureEntries(measured, tone) {
  const entries = [];
  const add = (prefix, key, value) => {
    const def = FEATURE_DEFS[prefix];
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    let v = value;
    if (def.domain === 'log') {
      if (value <= 0) return;
      v = Math.log10(value);
    }
    entries.push({ id: key === null ? prefix : `${prefix}@${key}`, ...def, key, value: v });
  };
  for (const octave of measured.spectrum.octaves) {
    const band = Math.floor(Math.log2(octave.scaleKm));
    add('power', band, octave.power);
    add('slope', band, octave.slope);
  }
  add('beta', null, measured.spectrum.beta);
  for (const band of measured.intermittency.bands) {
    const j = Math.floor(Math.log2(band.scaleKm));
    add('kurtosis', j, band.kurtosis);
    add('energyCv', j, band.energyCv);
  }
  add('excess', null, measured.periodicity.maxExcessRatio);
  add('fitSlope', null, measured.periodicity.fitSlope);
  add('b', null, measured.shapes.sizeExponent);
  add('D', null, measured.shapes.perimeterAreaDimension);
  add('cloudyShare', null, measured.shapes.cloudyShare);
  add('cloudCount', null, measured.shapes.count);
  for (const cell of measured.anisotropy) {
    add('anisoCoherence', cell.scaleKm, cell.coherence);
    add('anisoR', cell.scaleKm, cell.r);
  }
  for (const block of measured.heterogeneity.blocks) add('hetI', block.blockKm, block.index);
  add('hetSlope', null, measured.heterogeneity.slope);
  add('hetClear', null, measured.heterogeneity.clearShare);
  add('hetDense', null, measured.heterogeneity.denseShare);
  add('toneMean', null, tone.mean);
  add('toneP50', null, tone.p50);
  add('toneP90', null, tone.p90);
  add('toneP99', null, tone.p99);
  return entries;
}

// PNG のバイト列から場を読み、物差し・階調・局所コントラスト・特徴量の一覧を 1 回で取る。
// illumination を渡すと、表示値をトーンマップ前の放射輝度へ戻してからその値で割って測る —
// 生成の撮影(放射輝度を表示用へ写した画)を、実写の補正反射率と同じ反射率相当へ換算するときに
// 使う。照明には太陽の入射に比例しない項(環境光など)も含めて渡す。
export function measureDetailImage(png, kmPerPx, illumination = 1) {
  const field = linearLuminanceField(png);
  if (illumination !== 1) {
    for (let i = 0; i < field.data.length; i++) {
      field.data[i] = invertNeutralDisplay(field.data[i]) / illumination;
    }
  }
  const crop = centerCrop(field);
  const tone = toneStats(crop.data);
  const contrast = localContrast(crop, kmPerPx);
  const measured = measureCloudDetail(field, kmPerPx);
  return {
    measured, tone, contrast,
    cropSize: measured.cropSize,
    features: featureEntries(measured, tone),
  };
}
