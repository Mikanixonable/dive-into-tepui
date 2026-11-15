// 半透明巻雲の窓の特徴量と区分判定。測る関数は純粋で、実写の教師窓と生成・描画の
// 出力へ同じように当てられる — 場 {width,height,data:0..1} と補助( km/px・雲マスク・
// COT/CTH・芯のマスク・風向 )だけを受けて JSON 化できる値を返す。
// 採用点の集計と report.json は cloud-translucent-report.mjs が担う。
import { pathToFileURL } from 'node:url';
import { fft2, measureCloudDetail } from './cloud-detail-metrics.mjs';
import { structureTensor, summarizeStructure } from './cloud-structure.mjs';
import { componentStats } from './cloud-components.mjs';
import { boxCounts, boxDimension, orientationCorrelationLength } from './cloud-fine-structure.mjs';
import { cropField } from './gray-image.mjs';
import { labelMask } from './cloud-translucent-gibs.mjs';

// 半透明・高層雲の条件(教師の窓のマスクの定義)。CTH [m] と COT [無次元]。
export const TRANSLUCENT_CTH_MIN_M = 6500;
export const TRANSLUCENT_COT_RANGE = [0.3, 23];

// 区分判定のしきい。実データの分布を見て調整する暫定値で、report.json の criteria へ複写する。
export const CLASSIFY = {
  scalyExcessMin: 1.5,
  scalyScaleKm: [2, 64],
  scalyCloudyMax: 0.9,
  streakCoherenceMin: 0.45,
  streakRMin: 0.5,
  veilCloudyMin: 0.5,
  veilCotP50: [0.3, 8],
  veilToneP50: [0.02, 0.7],
  veilLargestShareMin: 0.6,
  veilSpeckleDiamKm: 2,
  veilSpeckleCountMin: 20,
};

// 構造テンソルを当てる尺度 [km]。測れるのは 4×kmPerPx 以上かつ窓の 1/4 以下。
const ANISO_SCALES_KM = [6.3, 20, 63];
// 芯からの距離帯 [km]。窓ごとの「芯へどれだけ張り付くか」の断面。
const ASSOC_BINS_KM = [[0, 20], [20, 60], [60, 120], [120, 240], [240, 480]];
// 勾配の相関を測るのに要る成分数。
const GRADIENT_MIN_COMPONENTS = 8;
// 帯域パワー分けの波長帯 [km](端は大きい側を含まない)。
const SPECTRAL_BANDS_KM = { share2_10: [2, 10], share10_60: [10, 60], share64up: [64, Infinity] };
// 箱次元を測る ε の帯 [km]。
const BOX_DIM_RANGE_KM = [4, 128];

// 昇順に並んだ値の分位(床の index、cloud-components と同じ取り方)。
export function quantileOfSorted(sorted, fraction) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// 値の並びの {p10, p50, p90, mean}。
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: quantileOfSorted(sorted, 0.1),
    p50: quantileOfSorted(sorted, 0.5),
    p90: quantileOfSorted(sorted, 0.9),
    mean: sorted.length === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

// 雲のしきい。cloud-detail-metrics と同じ場面の分位 p50 + 0.3×(p99 − p50)。
function maskThreshold(data) {
  const sorted = Float64Array.from(data).sort();
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  return p50 + 0.3 * (p99 - p50);
}

// 動径スペクトル E[k](k = 1..n/2)。measureCloudDetail と同じ窓掛け・正規化で、
// 波数 k ごとの電力を返す(波長帯の電力割合を細かい刻みで足すため)。
function radialPower(data, n) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    const wy = 0.5 * (1 - Math.cos((2 * Math.PI * (y + 0.5)) / n));
    for (let x = 0; x < n; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * (x + 0.5)) / n));
      re[y * n + x] = (data[y * n + x] - mean) * wx * wy;
    }
  }
  fft2(re, im, n, false);
  const power = new Float64Array(n / 2 + 1);
  for (let ky = 0; ky < n; ky++) {
    const fy = Math.min(ky, n - ky);
    for (let kx = 0; kx < n; kx++) {
      const fx = Math.min(kx, n - kx);
      const k = Math.round(Math.hypot(fx, fy));
      if (k < 1 || k > n / 2) continue;
      const i = ky * n + kx;
      power[k] += (re[i] * re[i] + im[i] * im[i]) / (n * n);
    }
  }
  return power;
}

// 波長帯 [km] ごとの電力割合。k ≥ 1 の全電力で割る。
function spectralShares(power, n, kmPerPx) {
  let total = 0;
  for (let k = 1; k <= n / 2; k++) total += power[k];
  const shares = {};
  for (const [name, [lo, hi]] of Object.entries(SPECTRAL_BANDS_KM)) {
    let sum = 0;
    for (let k = 1; k <= n / 2; k++) {
      const lambda = (n * kmPerPx) / k;
      if (lambda >= lo && lambda < hi) sum += power[k];
    }
    shares[name] = total > 0 ? sum / total : 0;
  }
  return shares;
}

// 二つの並びのピアソン相関。点数 2 未満か分散 0 なら null。
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n;
  my /= n;
  let sxy = 0;
  let s2x = 0;
  let s2y = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    s2x += (xs[i] - mx) ** 2;
    s2y += (ys[i] - my) ** 2;
  }
  if (s2x <= 0 || s2y <= 0) return null;
  return sxy / Math.sqrt(s2x * s2y);
}

// 成分(重心・面積)の並びの主軸の向き [deg](x=東、y=南の画像座標、0..180)。
// 面積で重み付けした重心の共分散の主固有ベクトル。
function principalAxisDeg(centroidX, centroidY, areas) {
  let total = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < centroidX.length; i++) {
    total += areas[i];
    mx += centroidX[i] * areas[i];
    my += centroidY[i] * areas[i];
  }
  mx /= total;
  my /= total;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < centroidX.length; i++) {
    const dx = centroidX[i] - mx;
    const dy = centroidY[i] - my;
    sxx += areas[i] * dx * dx;
    syy += areas[i] * dy * dy;
    sxy += areas[i] * dx * dy;
  }
  return (Math.atan2(2 * sxy, sxx - syy) / 2) * (180 / Math.PI);
}

// 芯のマスクからの距離場 [km]。マルチソース BFS(8 近傍の 1/√2 斜め重み)で測る。
function distanceFromMask(coreMask, n, kmPerPx) {
  const dist = new Float64Array(n * n).fill(Infinity);
  const queue = [];
  for (let i = 0; i < n * n; i++) {
    if (coreMask[i] === 1) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  let head = 0;
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (head < queue.length) {
    const at = queue[head++];
    const x = at % n;
    const y = Math.floor(at / n);
    for (const [dx, dy, w] of steps) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const next = ny * n + nx;
      const candidate = dist[at] + w * kmPerPx;
      if (candidate < dist[next]) {
        dist[next] = candidate;
        queue.push(next);
      }
    }
  }
  return dist;
}

// 窓の測定。field は 0..1 の輝度場。aux: { kmPerPx, mask?, cot?, cth?, coreMask?,
// windDeg?, assocRadiusKm? }。mask が無ければ場面の分位で導く。返り値は JSON 化できる。
export function measureTranslucentWindow(field, aux = {}) {
  const kmPerPx = aux.kmPerPx;
  const limit = Math.min(512, field.width, field.height);
  const n = 1 << Math.floor(Math.log2(limit));
  const x0 = Math.floor((field.width - n) / 2);
  const y0 = Math.floor((field.height - n) / 2);
  const crop = cropField(field, x0, y0, n, n);
  const f = crop.data;
  const cropArray = (array) => {
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      out.set(array.subarray((y0 + y) * field.width + x0, (y0 + y) * field.width + x0 + n), y * n);
    }
    return out;
  };
  const threshold = maskThreshold(f);
  const mask = aux.mask !== undefined
    ? Uint8Array.from(cropArray(Float32Array.from(aux.mask)), (v) => (v > 0.5 ? 1 : 0))
    : Uint8Array.from(f, (v) => (v > threshold ? 1 : 0));
  const frameKm = n * kmPerPx;
  const rowKmPerPx = new Float64Array(n).fill(kmPerPx);
  const maskField = { width: n, height: n, data: Float32Array.from(mask) };

  // 階調と勾配(マスク内)。
  const masked = [];
  let gradSum = 0;
  let gradCount = 0;
  let cloudyCount = 0;
  let gapIntensitySum = 0;
  let gapCount = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (mask[i] === 1) {
        masked.push(f[i]);
        cloudyCount++;
      } else {
        gapIntensitySum += f[i];
        gapCount++;
      }
      if (mask[i] === 1 && x > 0 && x < n - 1 && y > 0 && y < n - 1) {
        const gx = (f[i + 1] - f[i - 1]) / (2 * kmPerPx);
        const gy = (f[i - n] - f[i + n]) / (2 * kmPerPx);
        gradSum += Math.hypot(gx, gy);
        gradCount++;
      }
    }
  }
  const cloudyShare = cloudyCount / (n * n);

  // マスク内の COT の中央値(veil の判定要素)。aux.cot は field で、無い層は未測定のまま。
  let cotP50 = null;
  if (aux.cot != null) {
    const cotField = cropArray(Float32Array.from(aux.cot.data));
    const cotValues = [];
    for (let i = 0; i < n * n; i++) {
      if (mask[i] === 1 && Number.isFinite(cotField[i])) cotValues.push(cotField[i]);
    }
    cotP50 = quantileOfSorted(cotValues.sort((a, b) => a - b), 0.5);
  }

  // スペクトル: β と周期性は measureCloudDetail、波長帯の電力割合は動径スペクトルから。
  const detail = measureCloudDetail(crop, kmPerPx);
  const power = radialPower(f, n);
  const shares = spectralShares(power, n, kmPerPx);
  let band2_10 = 0;
  let band10_60 = 0;
  for (let k = 1; k <= n / 2; k++) {
    const lambda = (n * kmPerPx) / k;
    if (lambda >= 2 && lambda < 10) band2_10 += power[k];
    if (lambda >= 10 && lambda < 60) band10_60 += power[k];
  }
  const midPowerRatio = band2_10 > 0 ? band10_60 / band2_10 : null;

  // 異方性: 測れる尺度の構造テンソル。
  const aniso = { scales: [], lThetaKm: null };
  for (const scaleKm of ANISO_SCALES_KM) {
    if (scaleKm < 4 * kmPerPx || scaleKm > frameKm / 4) continue;
    const structure = structureTensor(crop, rowKmPerPx, kmPerPx, false, scaleKm);
    const summary = summarizeStructure(structure, 0, 0, n, n);
    const entry = { scaleKm, ...summary };
    if (scaleKm === 63) {
      const lTheta = orientationCorrelationLength(structure, kmPerPx, frameKm / 4);
      aniso.lThetaKm = lTheta === null ? null : lTheta.lThetaKm;
    }
    aniso.scales.push(entry);
  }
  const atScale = (km) => aniso.scales.find((s) => s.scaleKm === km) ?? null;

  // 雲の塊と晴れの成分(マスクに対して測る)。
  const shapes = componentStats(maskField, 0.5, false, rowKmPerPx, kmPerPx);
  const invMask = { width: n, height: n, data: Float32Array.from(mask, (v) => 1 - v) };
  const gapStats = componentStats(invMask, 0.5, false, rowKmPerPx, kmPerPx);
  const gapAreas = gapStats.components.map((c) => c.areaKm2).sort((a, b) => a - b);

  // scaly の判定要素(全全窓で測る — 区分比較に使う)。
  const labels = labelMask(mask, n, n);
  const components = labels.sizes.map((size, i) => ({
    areaKm2: size * kmPerPx * kmPerPx,
    cx: labels.centroidX[i],
    cy: labels.centroidY[i],
  }));
  // 塊の等価直径 [km] の分布 — 鱗雲の粒の尺度(2〜20 km)を見る用。
  const clumpDiams = components.map((c) => 2 * Math.sqrt(c.areaKm2 / Math.PI)).sort((a, b) => a - b);
  const dimension = boxDimension(boxCounts(mask, n, n), kmPerPx, BOX_DIM_RANGE_KM[0], BOX_DIM_RANGE_KM[1]);
  const clusterAniso = {};
  for (const scaleKm of [20, 63]) {
    if (scaleKm < 4 * kmPerPx || scaleKm > frameKm / 4) continue;
    const structure = structureTensor(maskField, rowKmPerPx, kmPerPx, false, scaleKm);
    clusterAniso[`s${scaleKm}`] = summarizeStructure(structure, 0, 0, n, n).coherence;
  }
  let gradient = null;
  if (components.length >= GRADIENT_MIN_COMPONENTS) {
    const axisDeg = principalAxisDeg(
      components.map((c) => c.cx), components.map((c) => c.cy), components.map((c) => c.areaKm2));
    const rad = (axisDeg * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    // 成分ごとの場の平均値。
    const sumField = new Float64Array(components.length);
    for (let i = 0; i < n * n; i++) {
      const l = labels.labels[i];
      if (l >= 0) sumField[l] += f[i];
    }
    const projections = components.map((c) => c.cx * ux + c.cy * uy);
    const rSize = pearson(projections, components.map((c) => Math.sqrt(c.areaKm2)));
    const rInt = pearson(projections, components.map((c, i) => sumField[i] / labels.sizes[i]));
    const strength = Math.max(Math.abs(rSize ?? 0), Math.abs(rInt ?? 0));
    gradient = { axisDeg: ((axisDeg % 180) + 180) % 180, rSize, rInt, strength };
  }
  // 縁と内部の勾配の強さの比。
  let edgeGradSum = 0;
  let edgeCount = 0;
  let innerGradSum = 0;
  let innerCount = 0;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (mask[i] === 0) continue;
      const gx = (f[i + 1] - f[i - 1]) / 2;
      const gy = (f[i - n] - f[i + n]) / 2;
      const g = Math.hypot(gx, gy);
      const edge = mask[i - 1] === 0 || mask[i + 1] === 0 || mask[i - n] === 0 || mask[i + n] === 0;
      if (edge) { edgeGradSum += g; edgeCount++; } else { innerGradSum += g; innerCount++; }
    }
  }
  const edgeSharpness = innerCount > 0 && innerGradSum > 0 && edgeCount > 0
    ? (edgeGradSum / edgeCount) / (innerGradSum / innerCount)
    : null;

  const measured = {
    kmPerPx,
    size: n,
    threshold,
    cloudyShare,
    cotP50,
    tone: distribution(masked),
    gapIntensity: gapCount > 0 ? gapIntensitySum / gapCount : null,
    edgeSharpness,
    gradMeanPerKm: gradCount > 0 ? gradSum / gradCount : 0,
    spectrum: { beta: detail.spectrum.beta, ...shares },
    midPowerRatio,
    periodicity: {
      excessRatio: detail.periodicity.maxExcessRatio,
      peakScaleKm: detail.periodicity.peakScaleKm,
    },
    aniso: {
      scales: aniso.scales,
      coherence20: atScale(20)?.coherence ?? null,
      coherence63: atScale(63)?.coherence ?? null,
      r63: atScale(63)?.r ?? null,
      orientationDeg63: atScale(63)?.orientationDeg ?? null,
      lThetaKm: aniso.lThetaKm,
    },
    heterogeneity: {
      slope: detail.heterogeneity.slope,
      clearShare: detail.heterogeneity.clearShare,
      denseShare: detail.heterogeneity.denseShare,
      hetI: detail.heterogeneity.blocks
        .reduce((best, b) => (best === null || Math.abs(b.blockKm - 64) < Math.abs(best.blockKm - 64) ? b : best), null)?.index ?? null,
    },
    shapes: {
      count: shapes.count,
      cloudyShare: shapes.cloudyShare,
      areaP50: shapes.areaKm2.median,
      areaP90: shapes.areaKm2.p90,
      largestShare: shapes.largestShare,
      holeShare: shapes.holeAreaShare,
    },
    gaps: {
      gapCount: gapStats.count,
      gapAreaP50: quantileOfSorted(gapAreas, 0.5),
      gapAreaP90: quantileOfSorted(gapAreas, 0.9),
      largestGapArea: gapAreas.at(-1) ?? 0,
    },
    scaly: {
      midPowerRatio,
      boxDim: dimension === null ? null : dimension.dimension,
      clumpCount: components.length,
      clumpDiamP50: quantileOfSorted(clumpDiams, 0.5),
      clumpDiamP90: quantileOfSorted(clumpDiams, 0.9),
      gapShare: 1 - cloudyShare,
      clearBlockShare: detail.heterogeneity.clearShare,
      clusterAniso,
      gradient,
      gapIntensity: gapCount > 0 ? gapIntensitySum / gapCount : null,
      edgeSharpness,
    },
    assoc: null,
  };

  // 芯との関係。芯のマスクがあるときは距離帯の断面・非対称・広がり比を測る。
  const coreMask = aux.coreMask != null
    ? Uint8Array.from(cropArray(Float32Array.from(aux.coreMask)), (v) => (v > 0.5 ? 1 : 0))
    : null;
  if (coreMask !== null && coreMask.some((v) => v === 1)) {
    const dist = distanceFromMask(coreMask, n, kmPerPx);
    const bins = ASSOC_BINS_KM.map(([loKm, hiKm]) => {
      let count = 0;
      let maskedCount = 0;
      let sum = 0;
      for (let i = 0; i < n * n; i++) {
        if (dist[i] >= loKm && dist[i] < hiKm) {
          count++;
          sum += f[i];
          if (mask[i] === 1) maskedCount++;
        }
      }
      return {
        loKm, hiKm,
        maskShare: count > 0 ? maskedCount / count : 0,
        meanField: count > 0 ? sum / count : 0,
      };
    });
    const coreLabels = labelMask(coreMask, n, n);
    const biggest = coreLabels.sizes.indexOf(Math.max(...coreLabels.sizes));
    const coreCx = coreLabels.centroidX[biggest];
    const coreCy = coreLabels.centroidY[biggest];
    let axisDeg = aux.windDeg ?? null;
    if (axisDeg === null) {
      const maskedX = [];
      const maskedY = [];
      const maskedA = [];
      for (const l of new Set(labels.labels.filter((v) => v >= 0))) {
        maskedX.push(labels.centroidX[l]);
        maskedY.push(labels.centroidY[l]);
        maskedA.push(labels.sizes[l]);
      }
      if (maskedX.length >= 2) axisDeg = principalAxisDeg(maskedX, maskedY, maskedA);
    }
    let asymmetry = null;
    if (axisDeg !== null) {
      // 半透明部の面積の偏り。半面の占有率にすると、芯が中央からずれただけで
      // 広い側が薄く見えてしまうので、面積(マスクの画素数)で比べる。
      const rad = (axisDeg * Math.PI) / 180;
      let down = 0;
      let up = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = y * n + x;
          const s = (x - coreCx) * Math.cos(rad) + (y - coreCy) * Math.sin(rad);
          if (s > 0) down += mask[i]; else up += mask[i];
        }
      }
      asymmetry = down + up > 0 ? (down - up) / (down + up) : null;
    }
    let coreArea = 0;
    for (const v of coreMask) coreArea += v;
    const centerDist = Math.hypot(n / 2 - coreCx, n / 2 - coreCy) * kmPerPx;
    measured.assoc = {
      bins,
      asymmetry,
      axisDeg,
      spreadRatio: coreArea > 0
        ? Math.sqrt(cloudyCount * kmPerPx * kmPerPx) / Math.sqrt(coreArea * kmPerPx * kmPerPx)
        : null,
      coreDistKm: centerDist + 0,
    };
  }
  return measured;
}

// 測定値から区分を推す。該当なしは null(unclassified)。発火した規則と読んだ値を返す。
export function classifyPattern(m) {
  const values = {
    excessRatio: m.periodicity.excessRatio,
    peakScaleKm: m.periodicity.peakScaleKm,
    cloudyShare: m.shapes.cloudyShare,
    coherence20: m.aniso.coherence20,
    coherence63: m.aniso.coherence63,
    r63: m.aniso.r63,
    share64up: m.spectrum.share64up,
    cotP50: m.cotP50 ?? null,
    toneP50: m.tone.p50,
    clumpCount: m.scaly.clumpCount,
    clumpDiamP50: m.scaly.clumpDiamP50,
    gapShare: m.scaly.gapShare,
  };
  // veil は鱗雲・筋より先に判定する — 占有率の高い薄い幕は、中規模の質感で
  // 構造の揃いが出ても幕として数えるのが区分の定義に近い。「連続した 1 成分」か
  // 「マスクが画素サイズの微小な斑(塊径 <2 km)に割れるだけ」の場を一様な幕とする。
  // ただし鱗雲の細胞の尺度(2〜20 km、塊の径の定義域)の強い周期峰を持つ場は
  // 幕でなく鱗雲側へ回す。20 km を超える周期は幕の中のうねりとみなす。
  const ex = m.periodicity.excessRatio;
  const pk = m.periodicity.peakScaleKm;
  const cellPeak = ex !== null && ex >= CLASSIFY.scalyExcessMin
    && pk !== null && pk >= CLASSIFY.scalyScaleKm[0] && pk <= 20;
  const scalyPeak = ex !== null && ex >= CLASSIFY.scalyExcessMin
    && pk !== null && pk >= CLASSIFY.scalyScaleKm[0] && pk <= CLASSIFY.scalyScaleKm[1];
  const cotOk = values.cotP50 !== null
    ? values.cotP50 >= CLASSIFY.veilCotP50[0] && values.cotP50 <= CLASSIFY.veilCotP50[1]
    : m.tone.p50 >= CLASSIFY.veilToneP50[0] && m.tone.p50 <= CLASSIFY.veilToneP50[1];
  const oneSheet = (m.shapes.largestShare ?? 0) >= CLASSIFY.veilLargestShareMin;
  const speckled = m.scaly.clumpDiamP50 > 0 && m.scaly.clumpDiamP50 < CLASSIFY.veilSpeckleDiamKm
    && m.scaly.clumpCount >= CLASSIFY.veilSpeckleCountMin;
  if (m.shapes.cloudyShare >= CLASSIFY.veilCloudyMin && cotOk && !cellPeak
    && (oneSheet || speckled)) {
    return { className: 'veil', rule: 'veil', values };
  }
  if (scalyPeak && m.shapes.cloudyShare <= CLASSIFY.scalyCloudyMax) {
    return { className: 'scaly', rule: 'scaly', values };
  }
  // 周期の峰が弱くても、塊に割れて隙間が多く塊の径が粒の尺度なら鱗雲。
  // ただし強く揃った塊場は筋側へ回す(coherence は streak 規則と同じ取り方)。
  const coherenceForClumps = Math.max(m.aniso.coherence20 ?? 0, m.aniso.coherence63 ?? 0);
  if (m.scaly.clumpCount >= 8 && m.scaly.clumpDiamP50 >= 2 && m.scaly.clumpDiamP50 <= 20
    && m.scaly.gapShare >= 0.6 && coherenceForClumps < CLASSIFY.streakCoherenceMin) {
    return { className: 'scaly', rule: 'scaly-clumps', values };
  }
  const coherence = Math.max(m.aniso.coherence20 ?? 0, m.aniso.coherence63 ?? 0);
  if (coherence >= CLASSIFY.streakCoherenceMin || (m.aniso.r63 ?? 0) >= CLASSIFY.streakRMin) {
    return { className: 'streak', rule: 'streak', values };
  }
  return { className: null, rule: 'unclassified', values };
}

// 直接起動したときは教師の集計(report.json・接触シート)を書く。
// 集計側がこの module の関数を使うため、循環を避けて実行時に読み込む。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { buildReport } = await import('./cloud-translucent-report.mjs');
  buildReport().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
