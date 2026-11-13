// 描画経路の多スケール撮影と実写の高解像度参照を、尺度帯ごとに比べる特徴量。
// 比較の単位は (地域, 梯子) の対で、生成は撮影を実写の箱の正距円筒へ載せ替えたもの、
// 実写は GIBS の可視 (筋は赤外 Band 13) を同じ箱・同じ画素数で読んだもの。
// 尺度帯は [2000–200 / 200–20 / 20–2 km]。帯ごとの値は、センサの階調差に依らないよう
// すべて正規化してある — 帯の電力割合、フラクタル次元、空隙率、帯域成分の形は、
// それぞれの場の自分の分布・自分の全電力で割って比べる。
// 場は { width, height, data } (0..1 の輝度) で受ける。PNG の復号と箱の対応付けは
// 呼び出し側 (cloud-lab-compare) が行い、ここは純粋な特徴量だけを持つ。

import { blurField, structureTensor, summarizeStructure } from './cloud-structure.mjs';
import { componentStats } from './cloud-components.mjs';

// 地球の平均半径 [km]。撮影の載せ替えは真球で解く — ゲームの地球は扁平だが、その差は
// 0.3% で、直す透視の歪み (枠端で 30%) に比べれば無視できる。
const EARTH_RADIUS_KM = 6371;

// 尺度帯 [km]。lo が短波長側、hi が長波長側。
export const FINE_BANDS = [
  { loKm: 200, hiKm: 2000 },
  { loKm: 20, hiKm: 200 },
  { loKm: 2, hiKm: 20 },
];

// 帯を主に測る梯子。2000–200 km 帯は 2000 km の梯子でしか枠に入らず、
// 200–20 / 20–2 km 帯は 400 km の梯子で最も細かく解ける。
// 2000 km の梯子での 200–20 km 帯は交叉確認として測り、距離には入れない。
export const FINE_PRIMARY_LADDER = {
  '200-2000': '2000km',
  '20-200': '400km',
  '2-20': '400km',
};

// 筋の構造テンソルを測る尺度 [km]。帯の幾何平均 (2000–200 → 632、200–20 → 63、20–2 → 6.3)。
export const FINE_STREAK_SCALES_KM = [632, 63, 6.3];

// 筋の向きの相関長を測る遅れ [km]。梯子ごとに測る上限まで使う。
const LTHETA_LAGS_KM = [10, 20, 40, 80, 160, 320, 640];

// 帯を測れる条件。長い側は枠の幅に収まり、短い側はナイキスト (2 px) より長いこと。
function bandMeasurable(band, frameWidthKm, kmPerPx) {
  return band.hiKm <= frameWidthKm && band.loKm >= 2 * kmPerPx;
}

// 昇順に並んだ値の分位。cloud-components.mjs の quantileOfSorted と同じ取り方(床の index)。
function quantileOfSorted(sorted, fraction) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// 0..1 の場を自分の 5–95 パーセンタイルで 0..1 へ直す。センサの階調差を吸収するための
// 相対化で、雲の明暗の順序だけを残す。
export function normalizeField(field) {
  const sorted = Float32Array.from(field.data).sort();
  const low = quantileOfSorted(sorted, 0.05);
  const high = quantileOfSorted(sorted, 0.95);
  const span = Math.max(1e-9, high - low);
  const out = new Float32Array(field.data.length);
  for (let i = 0; i < field.data.length; i++) {
    out[i] = Math.min(1, Math.max(0, (field.data[i] - low) / span));
  }
  return { width: field.width, height: field.height, data: out };
}

// 正規化した場の二値マスク。0.5 より明るい画素を「雲」とする — 絶対の輝度ではなく、
// その枠の自分の階調の中央より明るいかどうかで決める。
export function binaryMask(field) {
  const normalized = normalizeField(field);
  const mask = new Uint8Array(field.data.length);
  for (let i = 0; i < normalized.data.length; i++) mask[i] = normalized.data[i] > 0.5 ? 1 : 0;
  return mask;
}

const degToRad = (deg) => (deg * Math.PI) / 180;

// 直下点 (latitudeDeg, longitudeDeg)・高度 cameraDistanceKm [km]・垂直画角 fovDeg の天底
// カメラで撮った場を、箱 { south, north, west, east } [°] の正距円筒 (width × height) へ
// 双一次で載せ替える。像の右が東・上が北 (LabView の天底配置の解析結果)。
// 枠の外 (地平線の向こう) は valid が 0 になる。返す validRect は valid がすべて 1 の
// 最大の矩形 { x0, y0, width, height } で、特徴量はこの矩形で測る。
// 箱の中心が直下点からずれている対 (npac-storm 2000 km) では、箱の東端が枠から出る。
export function resampleCaptureToBox(capture, latitudeDeg, longitudeDeg, cameraDistanceKm, fovDeg, box, width, height) {
  const fPx = (capture.height / 2) / Math.tan(degToRad(fovDeg) / 2);
  const lat0 = degToRad(latitudeDeg);
  const lon0 = degToRad(longitudeDeg);
  // 直下点の天体固定の東・北・上 (正距円筒の取り決め: 経度 0 が +Z、東が +X、北極が +Y)。
  const east0 = [Math.cos(lon0), 0, -Math.sin(lon0)];
  const north0 = [
    -Math.sin(lat0) * Math.sin(lon0), Math.cos(lat0), -Math.sin(lat0) * Math.cos(lon0),
  ];
  const up0 = [
    Math.cos(lat0) * Math.sin(lon0), Math.sin(lat0), Math.cos(lat0) * Math.cos(lon0),
  ];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const out = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const lat = degToRad(box.north - ((y + 0.5) / height) * (box.north - box.south));
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    for (let x = 0; x < width; x++) {
      const lon = degToRad(box.west + ((x + 0.5) / width) * (box.east - box.west));
      const u = [cosLat * Math.sin(lon), sinLat, cosLat * Math.cos(lon)];
      const e = dot(u, east0);
      const n = dot(u, north0);
      const c = dot(u, up0);
      // 視線の深さ (forward = -up)。z <= 0 は地平線の向こう。
      const z = EARTH_RADIUS_KM + cameraDistanceKm - EARTH_RADIUS_KM * c;
      if (z <= 0) continue;
      const px = capture.width / 2 + (fPx * EARTH_RADIUS_KM * e) / z;
      const py = capture.height / 2 - (fPx * EARTH_RADIUS_KM * n) / z;
      if (px < 0 || px > capture.width - 1 || py < 0 || py > capture.height - 1) continue;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const x1 = Math.min(capture.width - 1, x0 + 1);
      const y1 = Math.min(capture.height - 1, y0 + 1);
      const { data, width: w } = capture;
      out[y * width + x] = data[y0 * w + x0] * (1 - fx) * (1 - fy)
        + data[y0 * w + x1] * fx * (1 - fy)
        + data[y1 * w + x0] * (1 - fx) * fy
        + data[y1 * w + x1] * fx * fy;
      valid[y * width + x] = 1;
    }
  }
  return { width, height, data: out, valid, validRect: largestValidRect(valid, width, height) };
}

// valid がすべて 1 の最大の矩形。行ごとの有効区間を上から下へ伸ばしながら、
// 区間の共通部分の幅 × 高さが最大のものを残す。
export function largestValidRect(valid, width, height) {
  const rowX0 = new Int32Array(height).fill(-1);
  const rowX1 = new Int32Array(height).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (valid[y * width + x] === 1) {
        if (rowX0[y] < 0) rowX0[y] = x;
        rowX1[y] = x;
      }
    }
  }
  let best = null;
  for (let y0 = 0; y0 < height; y0++) {
    if (rowX0[y0] < 0) continue;
    let x0 = rowX0[y0];
    let x1 = rowX1[y0];
    for (let y1 = y0; y1 < height; y1++) {
      if (rowX0[y1] < 0) break;
      x0 = Math.max(x0, rowX0[y1]);
      x1 = Math.min(x1, rowX1[y1]);
      if (x1 < x0) break;
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (best === null || area > best.width * best.height) {
        best = { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
      }
    }
  }
  return best;
}

// 2 の冪の長さへ 0 で埋めるための、次の 2 の冪。
function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// 基数 2 の反復 FFT。re/im は長さ n (2 の冪) の配列で、その場で書き換える。
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nextWr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nextWr;
      }
    }
  }
}

// 行方向の 1 次元パワースペクトル。1 行おきに間引き、行ごとに平均を引いて Hann 窓を掛け、
// 波数 k ごとの電力を全行で平均する。行は次の 2 の冪へ 0 で埋めて FFT し、
// 返す power[k] は k = 0..n/2。波長 [km] は (n × kmPerPx) / k — 0 埋めの分だけ
// 周波数の刻みが細かくなるので、枠の幅ではなく埋めた後の長さで割る。
export function rowBandPowers(field, kmPerPx) {
  const { width, height, data } = field;
  const n = nextPow2(width);
  const power = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let rows = 0;
  for (let y = 0; y < height; y += 2) {
    const row = data.subarray(y * width, (y + 1) * width);
    let mean = 0;
    for (const v of row) mean += v;
    mean /= width;
    re.fill(0);
    im.fill(0);
    for (let x = 0; x < width; x++) {
      // Hann 窓。行の両端の不連続が低波数へ漏れるのを抑える。
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (width - 1)));
      re[x] = (row[x] - mean) * window;
    }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) / (width * width);
    rows++;
  }
  for (let k = 0; k <= n / 2; k++) power[k] /= rows;
  return { power, frameWidthKm: n * kmPerPx };
}

// 波数ごとの電力から、帯 [loKm, hiKm] の電力割合を出す。分母は k >= 1 の全電力で、
// センサの階調差 (全体の倍率) は分子・分母で消える。
export function bandShares(rowPowers, bands) {
  const { power, frameWidthKm } = rowPowers;
  let total = 0;
  for (let k = 1; k < power.length; k++) total += power[k];
  return bands.map((band) => {
    let sum = 0;
    for (let k = 1; k < power.length; k++) {
      const wavelengthKm = frameWidthKm / k;
      if (wavelengthKm >= band.loKm && wavelengthKm <= band.hiKm) sum += power[k];
    }
    return { ...band, share: total > 0 ? sum / total : 0 };
  });
}

// 二値マスクの箱数え。1 辺 ε [px] (2 の冪) の箱で覆い、雲を含む箱の数を数える。
// ε は 2 px から min(width, height) / 2 まで。
export function boxCounts(mask, width, height) {
  const counts = [];
  for (let epsilon = 2; epsilon * 2 <= Math.min(width, height); epsilon *= 2) {
    const boxesX = Math.ceil(width / epsilon);
    const boxesY = Math.ceil(height / epsilon);
    const seen = new Uint8Array(boxesX * boxesY);
    let count = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x] === 0) continue;
        const box = Math.floor(y / epsilon) * boxesX + Math.floor(x / epsilon);
        if (seen[box] === 0) {
          seen[box] = 1;
          count++;
        }
      }
    }
    counts.push({ epsilonPx: epsilon, count });
  }
  return counts;
}

// 箱数えから、帯 [loKm, hiKm] の箱次元を最小二乗で読む。ε の地上換算が帯に入る点を
// 3 点以上使えなければ測れない (null)。
export function boxDimension(counts, kmPerPx, loKm, hiKm) {
  const points = counts
    .filter((entry) => entry.epsilonPx * kmPerPx >= loKm && entry.epsilonPx * kmPerPx <= hiKm)
    .map((entry) => ({ x: Math.log(1 / entry.epsilonPx), y: Math.log(Math.max(1, entry.count)) }));
  if (points.length < 3) return null;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY);
    denominator += (p.x - meanX) ** 2;
  }
  if (denominator <= 0) return null;
  return { dimension: numerator / denominator, points: points.length };
}

// 二値マスクの空隙率 Λ(ε)。積算画像で 1 辺 ε のすべり箱の雲量を求め、
// Λ = Var / Mean² + 1。ε は箱数えと同じ 2 の冪の格子で、すべりの刻みは ε/4。
// 箱数が 25 未満の ε は当てにならないので除く。
export function lacunarityValues(mask, width, height) {
  // 積算画像 (summed-area table)。sat[(y+1)*(width+1) + (x+1)] は (0..x, 0..y) の和。
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += mask[y * width + x];
      sat[(y + 1) * (width + 1) + (x + 1)] = sat[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  const boxSum = (x0, y0, x1, y1) => sat[(y1 + 1) * (width + 1) + (x1 + 1)]
    - sat[y0 * (width + 1) + (x1 + 1)]
    - sat[(y1 + 1) * (width + 1) + x0]
    + sat[y0 * (width + 1) + x0];
  const values = [];
  for (let epsilon = 2; epsilon * 2 <= Math.min(width, height); epsilon *= 2) {
    const stride = Math.max(1, Math.floor(epsilon / 4));
    let n = 0;
    let sum = 0;
    let sumSq = 0;
    for (let y0 = 0; y0 + epsilon <= height; y0 += stride) {
      for (let x0 = 0; x0 + epsilon <= width; x0 += stride) {
        const mass = boxSum(x0, y0, x0 + epsilon - 1, y0 + epsilon - 1);
        n++;
        sum += mass;
        sumSq += mass * mass;
      }
    }
    if (n < 25) continue;
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    values.push({ epsilonPx: epsilon, lambda: mean > 0 ? variance / (mean * mean) + 1 : 0, boxes: n });
  }
  return values;
}

// 帯 [loKm, hiKm] の空隙率。帯に入る ε の log Λ の平均で、2 点以上なければ測れない (null)。
export function bandLacunarity(values, kmPerPx, loKm, hiKm) {
  const logs = values
    .filter((entry) => entry.epsilonPx * kmPerPx >= loKm && entry.epsilonPx * kmPerPx <= hiKm)
    .map((entry) => Math.log(Math.max(1e-9, entry.lambda)));
  if (logs.length < 2) return null;
  return { logLambda: logs.reduce((sum, v) => sum + v, 0) / logs.length, points: logs.length };
}

// 場を σ [km] でガウスに近い幅で均す。rowKmPerPx が一定の平坦な枠用の薄い包み。
function blurKm(field, sigmaKm, kmPerPx) {
  const rowKmPerPx = new Array(field.height).fill(kmPerPx);
  const blurred = blurField(field.data, field.width, field.height, rowKmPerPx, kmPerPx, false, sigmaKm);
  return { width: field.width, height: field.height, data: blurred };
}

// 帯 [loKm, hiKm] の成分統計。2 つのぼかしの差 (DoG) で帯域だけを抜き、
// 正のふくらみ (その尺度の明るい構造) をしきい 0 で成分に分ける。面積と周囲は地表の km 換算。
export function bandComponents(field, kmPerPx, loKm, hiKm) {
  const fine = blurKm(field, loKm / 4, kmPerPx);
  const coarse = blurKm(field, hiKm / 4, kmPerPx);
  const dog = new Float32Array(field.data.length);
  for (let i = 0; i < dog.length; i++) dog[i] = fine.data[i] - coarse.data[i];
  const rowKmPerPx = new Array(field.height).fill(kmPerPx);
  const stats = componentStats(
    { width: field.width, height: field.height, data: dog }, 0, false, rowKmPerPx, kmPerPx);
  return {
    count: stats.count,
    medianAreaKm2: stats.areaKm2.median,
    largestShare: stats.largestShare,
    perimeterPerArea: stats.perimeterPerArea,
  };
}

// 2 つの向き [°] (0..180) の円距離 [°]。筋の向きは 180° で 1 周するので、差は 0..90° に収まる。
export function orientationDifferenceDeg(a, b) {
  const diff = Math.abs(a - b) % 180;
  return Math.min(diff, 180 - diff);
}

// 筋の向きの相関長 Lθ [km]。構造テンソルの向きの場から、遅れ r ごとに
// C(r) = <cos 2Δθ> (異方性の強さで重み付け) を測り、1/e を切る遅れを線形補間で読む。
// 切らなければ null (相関長が測った範囲より長い)。
export function orientationCorrelationLength(structure, kmPerPx, maxLagKm = 320) {
  const { width, height, diff, angle } = structure;
  // 決定的な抽出。異方性のある画素だけが向きを持つ。
  let seed = 123456789;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const points = [];
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(random() * width);
    const y = Math.floor(random() * height);
    const at = y * width + x;
    if (diff[at] > 1e-12) points.push({ x, y, angle: angle[at], weight: diff[at] });
  }
  if (points.length < 100) return null;
  const lags = LTHETA_LAGS_KM.filter((lag) => lag <= maxLagKm);
  const correlations = [];
  const directions = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  for (const lagKm of lags) {
    const lagPx = lagKm / kmPerPx;
    let weightedSum = 0;
    let weightSum = 0;
    for (const point of points) {
      for (const [dx, dy] of directions) {
        const x = Math.round(point.x + dx * lagPx);
        const y = Math.round(point.y + dy * lagPx);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const at = y * width + x;
        if (diff[at] <= 1e-12) continue;
        const weight = Math.sqrt(point.weight * diff[at]);
        weightedSum += weight * Math.cos(2 * (angle[at] - point.angle));
        weightSum += weight;
      }
    }
    if (weightSum <= 0) continue;
    correlations.push({ lagKm, value: weightedSum / weightSum });
  }
  // 遅れ 0 では C = 1 (同じ画素) なので、そこを起点に 1/e を切る遅れを線形補間で読む。
  // 最初の遅れですでに 1/e を切っている (向きが画素ごとにばらばら) 場合もここで拾う。
  const anchored = [{ lagKm: 0, value: 1 }, ...correlations];
  let lThetaKm = null;
  for (let i = 1; i < anchored.length; i++) {
    if (anchored[i - 1].value >= 1 / Math.E && anchored[i].value < 1 / Math.E) {
      const before = anchored[i - 1];
      const after = anchored[i];
      const fraction = (before.value - 1 / Math.E) / (before.value - after.value);
      lThetaKm = before.lagKm + fraction * (after.lagKm - before.lagKm);
      break;
    }
  }
  return { lThetaKm, correlations };
}

// 筋のテンソルを測れる尺度 [km]。ぼかしが枠に収まり、尺度が 4 px より長いこと。
function streakScaleMeasurable(scaleKm, frameWidthKm, kmPerPx) {
  return scaleKm <= frameWidthKm / 4 && scaleKm >= 4 * kmPerPx;
}

// 1 つの対 (地域, 梯子) の微細構造の特徴量。visible は可視の対、streak は巻雲の筋の対で、
// 生成はどちらも同じ撮影の輝度、実写は可視が Band 3 / Band 2 / VIIRS、筋が Band 13。
// streak が null の対 (sahara — 赤外の参照が無い) では筋は測らない。
// 返す値はすべて、帯と梯子の対応付け (primary) を添えた生の特徴量で、距離への落とし方は
// cloud-distances.mjs が決める。
export function measureFinePair(generatedVisible, referenceVisible, referenceStreak, kmPerPx, ladder) {
  const frameWidthKm = generatedVisible.width * kmPerPx;
  const generatedPowers = rowBandPowers(generatedVisible, kmPerPx);
  const referencePowers = rowBandPowers(referenceVisible, kmPerPx);
  const generatedShares = bandShares(generatedPowers, FINE_BANDS);
  const referenceShares = bandShares(referencePowers, FINE_BANDS);
  const generatedMask = binaryMask(generatedVisible);
  const referenceMask = binaryMask(referenceVisible);
  const generatedCounts = boxCounts(
    generatedMask, generatedVisible.width, generatedVisible.height);
  const referenceCounts = boxCounts(
    referenceMask, referenceVisible.width, referenceVisible.height);
  const generatedLacunarity = lacunarityValues(
    generatedMask, generatedVisible.width, generatedVisible.height);
  const referenceLacunarity = lacunarityValues(
    referenceMask, referenceVisible.width, referenceVisible.height);

  const bands = [];
  for (let i = 0; i < FINE_BANDS.length; i++) {
    const band = FINE_BANDS[i];
    const key = `${band.loKm}-${band.hiKm}`;
    const primary = FINE_PRIMARY_LADDER[key] === ladder;
    if (!bandMeasurable(band, frameWidthKm, kmPerPx)) continue;
    const generatedDimension = boxDimension(generatedCounts, kmPerPx, band.loKm, band.hiKm);
    const referenceDimension = boxDimension(referenceCounts, kmPerPx, band.loKm, band.hiKm);
    const generatedLac = bandLacunarity(generatedLacunarity, kmPerPx, band.loKm, band.hiKm);
    const referenceLac = bandLacunarity(referenceLacunarity, kmPerPx, band.loKm, band.hiKm);
    bands.push({
      ...band,
      primary,
      generatedShare: generatedShares[i].share,
      referenceShare: referenceShares[i].share,
      boxDimension: generatedDimension === null || referenceDimension === null ? null : {
        generated: generatedDimension.dimension,
        reference: referenceDimension.dimension,
      },
      lacunarity: generatedLac === null || referenceLac === null ? null : {
        generated: generatedLac.logLambda,
        reference: referenceLac.logLambda,
      },
      components: {
        generated: bandComponents(generatedVisible, kmPerPx, band.loKm, band.hiKm),
        reference: bandComponents(referenceVisible, kmPerPx, band.loKm, band.hiKm),
      },
    });
  }

  let streak = null;
  if (referenceStreak !== null) {
    const rowKmPerPx = new Array(generatedVisible.height).fill(kmPerPx);
    const tensors = new Map();
    for (const scaleKm of FINE_STREAK_SCALES_KM) {
      if (!streakScaleMeasurable(scaleKm, frameWidthKm, kmPerPx)) continue;
      tensors.set(scaleKm, {
        generated: structureTensor(generatedVisible, rowKmPerPx, kmPerPx, false, scaleKm),
        reference: structureTensor(referenceStreak, rowKmPerPx, kmPerPx, false, scaleKm),
      });
    }
    const scales = [...tensors.entries()].map(([scaleKm, tensor]) => ({
      scaleKm,
      generated: summarizeStructure(
        tensor.generated, 0, 0, generatedVisible.width, generatedVisible.height),
      reference: summarizeStructure(
        tensor.reference, 0, 0, referenceStreak.width, referenceStreak.height),
    }));
    // 向きの相関長は 63 km の尺度で読む。2000 km の梯子では遅れを 640 km まで伸ばす。
    const lThetaTensor = tensors.get(63);
    let lThetaKm = null;
    if (lThetaTensor !== undefined) {
      const generatedLTheta = orientationCorrelationLength(
        lThetaTensor.generated, kmPerPx, ladder === '2000km' ? 640 : 320);
      const referenceLTheta = orientationCorrelationLength(
        lThetaTensor.reference, kmPerPx, ladder === '2000km' ? 640 : 320);
      if (generatedLTheta !== null && referenceLTheta !== null) {
        lThetaKm = {
          generated: generatedLTheta.lThetaKm,
          reference: referenceLTheta.lThetaKm,
        };
      }
    }
    streak = { scales, lThetaKm };
  }
  return { bands, streak };
}
