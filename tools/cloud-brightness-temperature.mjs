// 帯 13(クリーン長波赤外窓)の描画 PNG から輝度温度 [℃] を復元する。巻雲基盤改訂で教師側の
// 層分離(低温 = 高層雲)に使う。描画は GIBS の Clean_Longwave_Infrared_Window_Band カラー
// マップで、色づけは単調でない: -19.1 ℃ までは虹色の強調、そこから暖側はグレーの濃淡、
// さらに -70.1..-80.1 ℃ には暖側と重なるグレーの濃淡が巻き返している(同じグレー値が
// 「非常に冷たい」と「暖かい」の両方を表す)。そのため単純な輝度や色の近さだけでは反転
// できない。本モジュールは色票への最近色で候補を出し、グレーの巻き返しは空間的な連結で
// 解く: -80..-70 ℃ の芯は輝度温度の連続性から必ず -70..-60 ℃ の色帯に囲まれるので、
// 色帯の低温画素に連結したグレー成分だけを冷たい側、残りを暖かい側と読む。
//
// 高層雲の切り分けの閾値: HIGH_CLOUD_THRESHOLD_C = -30 ℃。根拠は reference-cirrus の
// マニフェストに残した帯 13 フレーム実測分布で、(1) 熱帯・中緯度の暖かい峰(海面と下層・
// 中層雲、およそ -20 ℃ 以上)と冷たい尾(対流圏上部の雲頂)の境目にあたる、(2) 対流圏
// 上部(熱帯でおおよそ 8 km 以上)の雲頂に対応し、生成側の半透明殻(巻雲層)が表す層と
// 対応する、(3) カラーマップ自身の強調が始まる -19.1 ℃ より十分に冷たく、薄い中層雲の
// 混入が小さい。冷たさの飽和は -70 ℃(深い対流の芯はこれより冷たくても層としては同じ)。

import { createHash } from 'node:crypto';

export const COLORMAP_URL =
  'https://gibs.earthdata.nasa.gov/colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml';
export const HIGH_CLOUD_THRESHOLD_C = -30;
export const HIGH_CLOUD_SATURATION_C = -70;

// カラーマップ XML を色票の並びにする。bin の [lo, hi) と代表値(中点)を持つ。
export function parseBand13Colormap(xmlText) {
  const entries = [];
  for (const m of xmlText.matchAll(
    /<ColorMapEntry[^>]*rgb="(\d+),(\d+),(\d+)"[^>]*sourceValue="\(([-\d.]+),([-\d.]+)\]"/g,
  )) {
    const lo = parseFloat(m[4]);
    const hi = parseFloat(m[5]);
    entries.push({
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      loC: lo,
      hiC: hi,
      midC: (lo + hi) / 2,
      gray: Number(m[1]) === Number(m[2]) && Number(m[2]) === Number(m[3]),
    });
  }
  entries.sort((a, b) => a.midC - b.midC);
  return entries;
}

// 色票の健全性を確かめる(フェッチャが取得時に呼ぶ)。bin が低温から高温まで切れ目なく
// 並び、グレーの巻き返し区間が想定どおりにあることを見る。
export function validateBand13Colormap(entries) {
  if (entries.length < 200) throw new Error(`カラーマップの色数が不足: ${entries.length}`);
  for (let i = 1; i < entries.length; i++) {
    if (Math.abs(entries[i].loC - entries[i - 1].hiC) > 0.6) {
      throw new Error(`カラーマップの bin が連続していない: ${entries[i - 1].hiC} → ${entries[i].loC}`);
    }
  }
  const coldGray = entries.filter((e) => e.gray && e.midC < -65);
  const warmGray = entries.filter((e) => e.gray && e.midC > -25);
  if (coldGray.length < 5 || warmGray.length < 50) {
    throw new Error('カラーマップにグレーの巻き返し区間が見当たらない');
  }
  const sha256 = createHash('sha256')
    .update(entries.map((e) => `${e.r},${e.g},${e.b}@${e.midC}`).join(';'))
    .digest('hex');
  return { count: entries.length, minC: entries[0].loC, maxC: entries[entries.length - 1].hiC, sha256 };
}

// グレーの 2 区間について、グレー値 → 輝度温度の補間関数を作る。
function grayRamp(entries, predicate) {
  const points = entries
    .filter((e) => e.gray && predicate(e))
    .map((e) => ({ level: e.r, midC: e.midC }))
    .sort((a, b) => b.level - a.level);
  return (level) => {
    if (points.length === 0) return null;
    if (level >= points[0].level) return points[0].midC;
    if (level <= points[points.length - 1].level) return points[points.length - 1].midC;
    for (let i = 1; i < points.length; i++) {
      if (level >= points[i].level) {
        const a = points[i - 1];
        const b = points[i];
        const t = (level - b.level) / (a.level - b.level);
        return b.midC + t * (a.midC - b.midC);
      }
    }
    return points[points.length - 1].midC;
  };
}

// 描画 PNG(RGB/RGBA の生デコード結果)を輝度温度の場へ反転する。戻り値の bt は
// 復元できなかった画素が NaN。stats は反転の内訳(診断用)。
export function invertBrightnessTemperature(image, entries) {
  const { width, height, channels, data } = image;
  const count = width * height;
  const bt = new Float32Array(count).fill(NaN);
  // 完全一致の早見と、5bit/軸の最近色 LUT(ブレンド画素用)。
  const exact = new Map();
  entries.forEach((e, i) => exact.set((e.r << 16) | (e.g << 8) | e.b, i));
  const LUT_BITS = 5;
  const LUT_SIZE = 1 << LUT_BITS;
  const SHIFT = 8 - LUT_BITS;
  const lut = new Int32Array(LUT_SIZE ** 3);
  for (let r = 0; r < LUT_SIZE; r++)
    for (let g = 0; g < LUT_SIZE; g++)
      for (let b = 0; b < LUT_SIZE; b++) {
        const cr = (r << SHIFT) + (1 << (SHIFT - 1));
        const cg = (g << SHIFT) + (1 << (SHIFT - 1));
        const cb = (b << SHIFT) + (1 << (SHIFT - 1));
        let best = Infinity;
        let bestIdx = 0;
        entries.forEach((e, i) => {
          const d = (e.r - cr) ** 2 + (e.g - cg) ** 2 + (e.b - cb) ** 2;
          if (d < best) {
            best = d;
            bestIdx = i;
          }
        });
        lut[(r * LUT_SIZE + g) * LUT_SIZE + b] = bestIdx;
      }
  const warmOfLevel = grayRamp(entries, (e) => e.midC > -25);
  const coldOfLevel = grayRamp(entries, (e) => e.midC < -65);
  const coldLevels = entries.filter((e) => e.gray && e.midC < -65).map((e) => e.r);
  const coldLevelMin = Math.min(...coldLevels);
  const coldLevelMax = Math.max(...coldLevels);
  const warmLevels = entries.filter((e) => e.gray && e.midC > -25).map((e) => e.r);
  const warmLevelMin = Math.min(...warmLevels);
  const warmLevelMax = Math.max(...warmLevels);

  let exactCount = 0;
  let distanceSum = 0;
  const ambiguous = []; // { index, warmC, coldC }
  for (let i = 0; i < count; i++) {
    const p = i * channels;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const key = (r << 16) | (g << 8) | b;
    let entry;
    if (exact.has(key)) {
      entry = entries[exact.get(key)];
      exactCount++;
    } else {
      entry = entries[lut[(((r >> SHIFT) * LUT_SIZE + (g >> SHIFT)) * LUT_SIZE) + (b >> SHIFT)]];
      distanceSum += Math.hypot(entry.r - r, entry.g - g, entry.b - b);
    }
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > 8) {
      // 色のついた画素は色帯の中で一意。
      bt[i] = entry.midC;
      continue;
    }
    // グレー画素: 自分のグレー値を 2 区間の物差しで読む。
    const level = Math.round((r + g + b) / 3);
    if (level >= 250) {
      // 最も冷たい bin が白。暖側の物差しには無い。
      bt[i] = entries[0].midC;
      continue;
    }
    const warmC = level >= warmLevelMin - 4 && level <= warmLevelMax + 4 ? warmOfLevel(level) : null;
    const coldC = level >= coldLevelMin && level <= coldLevelMax ? coldOfLevel(level) : null;
    if (warmC !== null && coldC !== null) {
      ambiguous.push({ index: i, warmC, coldC });
    } else if (coldC !== null) {
      bt[i] = coldC;
    } else if (warmC !== null) {
      bt[i] = warmC;
    }
  }
  // 曖昧なグレーは「輝度温度の場は滑らか」という拘束で解く。冷たいグレーの区間
  // (-80..-70 ℃)は深い対流の芯にしか現れず、周囲は必ず色帯の低温画素に囲まれる。
  // 逆に暖かい側のグレーは大陸のように広く連結しているので、連結成分で伝播させると
  // 画面全体が冷たい側へ倒れる。そこで曖昧な画素は暖かい候補から出発し、近傍の
  // 決定済み画素の平均に近い候補へ繰り返し寄せていく(値の連続性による緩和)。
  const choice = new Float32Array(count);
  for (let i = 0; i < count; i++) if (!Number.isNaN(bt[i])) choice[i] = bt[i];
  for (const a of ambiguous) choice[a.index] = a.warmC;
  for (let iteration = 0; iteration < 100; iteration++) {
    let changed = 0;
    for (const a of ambiguous) {
      const x = a.index % width;
      const y = Math.floor(a.index / width);
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          sum += choice[ny * width + nx];
          n++;
        }
      if (n === 0) continue;
      const mean = sum / n;
      const next = Math.abs(a.coldC - mean) < Math.abs(a.warmC - mean) ? a.coldC : a.warmC;
      if (next !== choice[a.index]) {
        choice[a.index] = next;
        changed++;
      }
    }
    if (changed === 0) break;
  }
  let coldGrayCount = 0;
  for (const a of ambiguous) {
    bt[a.index] = choice[a.index];
    if (choice[a.index] === a.coldC) coldGrayCount++;
  }
  const blended = count - exactCount;
  return {
    width,
    height,
    data: bt,
    stats: {
      exactFraction: exactCount / count,
      meanBlendDistance: blended > 0 ? distanceSum / blended : 0,
      ambiguousFraction: ambiguous.length / count,
      coldGrayFraction: coldGrayCount / count,
    },
  };
}

// 輝度温度の場から「冷たさ」の場を作る。閾値より暖かい側は 0、飽和より冷たい側は 1、
// その間は線形。NaN は 0(層の外)として扱う。これが教師側の巻雲層の場になる。
export function coldnessField(btField, thresholdC = HIGH_CLOUD_THRESHOLD_C, saturationC = HIGH_CLOUD_SATURATION_C) {
  const out = new Float32Array(btField.data.length);
  const span = thresholdC - saturationC;
  for (let i = 0; i < btField.data.length; i++) {
    const v = btField.data[i];
    out[i] = Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, (thresholdC - v) / span));
  }
  return { width: btField.width, height: btField.height, data: out };
}
