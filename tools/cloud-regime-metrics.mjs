// 標本(1 タイル = 共通のデータ形)の配列を受ける統計。条件 → 形態の応答、条件が説明する分散、
// タイル間の変動の距離依存(バリオグラム)を、実写と生成で同じ式に通して比べる。
// 円周量(orientDeg・windLowDir・windUpDir)はここの一般の統計に入れない。向きどうしを比べるときは
// withAlignment が作る |cos| の量(alignLow / alignUp)を使う。

// 円周量。一般の平均・分位・分散へ入れると 0 度と 180 度が遠く見えるので、ここで止める。
const CIRCULAR = new Set(['orientDeg', 'windLowDir', 'windUpDir']);
export const VARIOGRAM_EDGES_KM = [200, 400, 700, 1000, 1400, 2000];
// 分位ビンの説明分散・バリオグラムで、これ未満の標本のセルは統計に入れない。
const MIN_CELL = 5;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function assertLinear(name) {
  if (CIRCULAR.has(name)) {
    throw new Error(`${name} は円周量なので一般の統計に入れない(withAlignment の alignLow / alignUp を使う)`);
  }
}

// 昇順の配列の分位点(線形補間、type 7)。
export function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

// 値の並びの要約。null・NaN は外す。
function summarize(values) {
  const finite = values.filter(isNum).sort((a, b) => a - b);
  const n = finite.length;
  if (n === 0) return { n: 0, mean: null, median: null, p25: null, p75: null };
  return {
    n,
    mean: finite.reduce((s, v) => s + v, 0) / n,
    median: quantileSorted(finite, 0.5),
    p25: quantileSorted(finite, 0.25),
    p75: quantileSorted(finite, 0.75),
  };
}

function meanOf(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// 条件の値を、その配列の中での順位 0..1 へ。同値は平均順位にする。null は null のまま。
// 単位が揃わない条件(advection・front・湿度)を、側ごとに比べられる形へ直すために使う。
export function rankNormalize(values) {
  const indices = [];
  for (let i = 0; i < values.length; i++) if (isNum(values[i])) indices.push(i);
  indices.sort((a, b) => values[a] - values[b]);
  const m = indices.length;
  const out = new Array(values.length).fill(null);
  let i = 0;
  while (i < m) {
    let j = i;
    while (j + 1 < m && values[indices[j + 1]] === values[indices[i]]) j++;
    const averageRank = (i + j) / 2;
    for (let k = i; k <= j; k++) out[indices[k]] = m === 1 ? 0.5 : averageRank / (m - 1);
    i = j + 1;
  }
  return out;
}

// 筋の向きと風の向きの揃い |cos(orientDeg − dirDeg)| を features.alignLow / alignUp として足す。
// 筋がほとんど無い(aniso < 0.1)か、向きや風が無いときは null。元の配列は書き換えない。
export function withAlignment(samples) {
  return samples.map((s) => {
    const { orientDeg, aniso } = s.features;
    const alignment = (dirDeg) => {
      if (!isNum(aniso) || aniso < 0.1 || !isNum(orientDeg) || !isNum(dirDeg)) return null;
      return Math.abs(Math.cos(((orientDeg - dirDeg) * Math.PI) / 180));
    };
    return {
      ...s,
      features: {
        ...s.features,
        alignLow: alignment(s.conditions?.windLowDir),
        alignUp: alignment(s.conditions?.windUpDir),
      },
    };
  });
}

// 条件の値で並べ、順位で bins 等分したビンごとの feature の要約。
// 順位で切るので、条件の単位や単調な変換に依らない。標本が bins に足りないときは空のビンが出る。
export function responseCurve(samples, condition, feature, bins = 5) {
  assertLinear(condition);
  assertLinear(feature);
  const rows = samples
    .filter((s) => isNum(s.conditions?.[condition]) && isNum(s.features?.[feature]))
    .sort((a, b) => a.conditions[condition] - b.conditions[condition]);
  return splitByRank(rows, bins).map((group, bin) => {
    const values = group.map((s) => s.features[feature]);
    const conditionValues = group.map((s) => s.conditions[condition]);
    return {
      bin,
      ...summarize(values),
      condLo: conditionValues.length ? Math.min(...conditionValues) : null,
      condHi: conditionValues.length ? Math.max(...conditionValues) : null,
    };
  });
}

// 順位で bins 等分する(rows は並べ替え済み)。
function splitByRank(rows, bins) {
  const groups = Array.from({ length: bins }, () => []);
  rows.forEach((row, rank) => groups[Math.floor((rank * bins) / rows.length)].push(row));
  return groups;
}

// 実写と生成の応答曲線の距離。scale は実写の feature の四分位範囲 ÷ 1.349(0 なら 1)で、
// d_i = (生成の平均 − 実写の平均) ÷ scale を各ビンで取る。
export function responseDistance(real, generated, condition, feature, bins = 5) {
  const realCurve = responseCurve(real, condition, feature, bins);
  const generatedCurve = responseCurve(generated, condition, feature, bins);
  const realValues = real.map((s) => s.features?.[feature]).filter(isNum);
  const realSummary = summarize(realValues);
  const iqr = realSummary.p75 - realSummary.p25;
  const scale = iqr / 1.349 > 0 ? iqr / 1.349 : 1;
  const pairs = realCurve
    .map((r, i) => ({ r, g: generatedCurve[i] }))
    .filter(({ r, g }) => r.n > 0 && g.n > 0);
  const d = pairs.map(({ r, g }) => (g.mean - r.mean) / scale);
  const bias = d.length ? meanOf(d) : null;
  const contrast = d.length ? Math.sqrt(meanOf(d.map((v) => (v - bias) ** 2))) : null;
  const rangeOf = (curve) => {
    const means = curve.filter((c) => c.n > 0).map((c) => c.mean);
    return means.length ? Math.max(...means) - Math.min(...means) : null;
  };
  const realRange = rangeOf(realCurve);
  const generatedRange = rangeOf(generatedCurve);
  return {
    bias,
    contrast,
    gainRatio: realRange > 0 ? generatedRange / realRange : null,
    corr: pearson(pairs.map(({ r }) => r.mean), pairs.map(({ g }) => g.mean)),
    realCurve,
    generatedCurve,
  };
}

// 2 つの系列の相関。分散が 0 のときや 2 点未満のときは null。
export function pearson(xs, ys) {
  if (xs.length < 2) return null;
  const mx = meanOf(xs);
  const my = meanOf(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// 条件のビン(順位で bins 等分)が feature の分散をどれだけ説明するか。η² = ビン間の分散 ÷ 全分散。
export function explainedVariance(samples, condition, feature, bins = 5) {
  assertLinear(condition);
  assertLinear(feature);
  const rows = samples
    .filter((s) => isNum(s.conditions?.[condition]) && isNum(s.features?.[feature]))
    .sort((a, b) => a.conditions[condition] - b.conditions[condition]);
  const values = rows.map((s) => s.features[feature]);
  const grand = meanOf(values);
  const total = values.reduce((s, v) => s + (v - grand) ** 2, 0);
  if (total <= 0) return null;
  const between = splitByRank(rows, bins).reduce((sum, group) => {
    if (group.length === 0) return sum;
    const groupMean = meanOf(group.map((s) => s.features[feature]));
    return sum + group.length * (groupMean - grand) ** 2;
  }, 0);
  return between / total;
}

// 複数の条件を各 bins 等分した直積のセルで測る η²。各条件の順位のビンでセルを作り、
// MIN_CELL 未満の標本のセルは外してから分散を比べる。
export function explainedVarianceJoint(samples, conditions, feature, bins = 3) {
  conditions.forEach(assertLinear);
  assertLinear(feature);
  const rows = samples.filter((s) => isNum(s.features?.[feature])
    && conditions.every((c) => isNum(s.conditions?.[c])));
  if (rows.length === 0) return null;
  const binOf = conditions.map((name) => {
    const order = rows.map((_, i) => i).sort((a, b) => rows[a].conditions[name] - rows[b].conditions[name]);
    const bin = new Array(rows.length);
    order.forEach((rowIndex, rank) => { bin[rowIndex] = Math.floor((rank * bins) / rows.length); });
    return bin;
  });
  const cells = new Map();
  rows.forEach((row, i) => {
    const key = binOf.map((bin) => bin[i]).join('|');
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row.features[feature]);
  });
  const kept = [...cells.values()].filter((values) => values.length >= MIN_CELL);
  const all = kept.flat();
  if (all.length === 0) return null;
  const grand = meanOf(all);
  const total = all.reduce((s, v) => s + (v - grand) ** 2, 0);
  if (total <= 0) return null;
  const between = kept.reduce((s, values) => s + values.length * (meanOf(values) - grand) ** 2, 0);
  return between / total;
}

// 場面内のタイルの対の、距離の帯ごとの半分散 γ(r) = ½·mean((f_a − f_b)²)。
// 対は同じ場面の中だけで作る(場面どうしの距離は意味を持たないため)。帯は [from, to) で、最後の帯だけ両端を含む。
export function variogram(samples, feature, edgesKm = VARIOGRAM_EDGES_KM) {
  assertLinear(feature);
  const bandCount = edgesKm.length - 1;
  const sums = new Float64Array(bandCount);
  const counts = new Float64Array(bandCount);
  const byScene = new Map();
  for (const s of samples) {
    if (!isNum(s.features?.[feature]) || !isNum(s.xKm) || !isNum(s.yKm)) continue;
    if (!byScene.has(s.scene)) byScene.set(s.scene, []);
    byScene.get(s.scene).push(s);
  }
  for (const group of byScene.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const distance = Math.hypot(a.xKm - b.xKm, a.yKm - b.yKm);
        const band = bandIndex(distance, edgesKm);
        if (band < 0) continue;
        sums[band] += (a.features[feature] - b.features[feature]) ** 2;
        counts[band]++;
      }
    }
  }
  return Array.from({ length: bandCount }, (_, band) => ({
    fromKm: edgesKm[band],
    toKm: edgesKm[band + 1],
    pairs: counts[band],
    gamma: counts[band] > 0 ? sums[band] / counts[band] / 2 : null,
  }));
}

// 距離が入る帯の番号。どの帯にも入らないときは -1。
function bandIndex(distance, edgesKm) {
  for (let band = 0; band < edgesKm.length - 1; band++) {
    const last = band === edgesKm.length - 2;
    if (distance >= edgesKm[band] && (distance < edgesKm[band + 1] || (last && distance <= edgesKm[band + 1]))) {
      return band;
    }
  }
  return -1;
}

// 実写と生成のバリオグラムの比較。各帯の γ を実写の全分散で割ってから、
// distance = 両方が正の帯の |ln(生成/実写)| の平均、rangeRatio = 最遠帯/最近帯 の比(生成 ÷ 実写)。
export function variogramDistance(real, generated, feature, edgesKm = VARIOGRAM_EDGES_KM) {
  assertLinear(feature);
  const realVariogram = variogram(real, feature, edgesKm);
  const generatedVariogram = variogram(generated, feature, edgesKm);
  const realValues = real.map((s) => s.features?.[feature]).filter(isNum);
  const grand = meanOf(realValues);
  const totalVariance = realValues.reduce((s, v) => s + (v - grand) ** 2, 0) / realValues.length;
  const normalized = (gamma) => (gamma !== null && totalVariance > 0 ? gamma / totalVariance : null);
  const bands = realVariogram.map((r, i) => {
    const realGamma = normalized(r.gamma);
    const generatedGamma = normalized(generatedVariogram[i].gamma);
    const valid = realGamma > 0 && generatedGamma > 0;
    return {
      fromKm: r.fromKm,
      toKm: r.toKm,
      real: realGamma,
      generated: generatedGamma,
      logRatio: valid ? Math.log(generatedGamma / realGamma) : null,
    };
  });
  const logs = bands.map((b) => b.logRatio).filter(isNum);
  const distance = logs.length ? meanOf(logs.map(Math.abs)) : null;
  const span = (key) => {
    const positives = bands.map((b) => b[key]).filter((v) => isNum(v) && v > 0);
    return positives.length >= 2 ? positives[positives.length - 1] / positives[0] : null;
  };
  const realSpan = span('real');
  const generatedSpan = span('generated');
  return {
    bands,
    distance,
    rangeRatio: realSpan > 0 && generatedSpan !== null ? generatedSpan / realSpan : null,
  };
}

// 乱数の種から決定的に一様乱数を出す(mulberry32)。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 場面を単位にした再標本化。各側で場面を復元抽出し、選ばれた場面のタイルを全部入れてから
// statistic(実写, 生成) を測る。statistic が null を返した回は捨てる。中央値と 5%・95% 点を返す。
export function bootstrapByScene(real, generated, statistic, { resamples = 200, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const realScenes = groupByScene(real);
  const generatedScenes = groupByScene(generated);
  const draws = [];
  for (let r = 0; r < resamples; r++) {
    const value = statistic(pickScenes(realScenes, rng), pickScenes(generatedScenes, rng));
    if (isNum(value)) draws.push(value);
  }
  if (draws.length === 0) return null;
  draws.sort((a, b) => a - b);
  return {
    median: quantileSorted(draws, 0.5),
    p05: quantileSorted(draws, 0.05),
    p95: quantileSorted(draws, 0.95),
    draws: draws.length,
  };
}

function groupByScene(samples) {
  const map = new Map();
  for (const s of samples) {
    if (!map.has(s.scene)) map.set(s.scene, []);
    map.get(s.scene).push(s);
  }
  return [...map.values()];
}

// 場面を復元抽出し、その場面のタイルを全部並べる。
function pickScenes(scenes, rng) {
  const out = [];
  for (let i = 0; i < scenes.length; i++) {
    const picked = scenes[Math.floor(rng() * scenes.length)];
    for (const s of picked) out.push(s);
  }
  return out;
}

// 人が読むための名前つきの気象型。条件の順位(withConditionRanks の conditionsRank)で判定する。
// 1 つの標本が複数の型に入ってよい。順位が null の条件を見る型には入れない。
export const REGIMES = [
  { id: 'ascent', label: '上昇域(低気圧・収束)', test: (r) => isNum(r.lift) && r.lift >= 0.8 },
  { id: 'descent', label: '沈降域(高気圧)', test: (r) => isNum(r.lift) && r.lift <= 0.2 },
  { id: 'cold', label: '寒気の移流', test: (r) => isNum(r.advection) && r.advection <= 0.2 },
  { id: 'warm', label: '暖気の移流', test: (r) => isNum(r.advection) && r.advection >= 0.8 },
  { id: 'front', label: '前線帯', test: (r) => isNum(r.front) && r.front >= 0.9 },
  { id: 'moist', label: '湿った下層', test: (r) => isNum(r.humidLow) && r.humidLow >= 0.8 },
  { id: 'dry', label: '乾いた下層', test: (r) => isNum(r.humidLow) && r.humidLow <= 0.2 },
  { id: 'windy', label: '下層の強風', test: (r) => isNum(r.windLow) && r.windLow >= 0.8 },
  { id: 'calm', label: '下層の弱風', test: (r) => isNum(r.windLow) && r.windLow <= 0.2 },
  {
    id: 'cold-descent',
    label: '寒気の移流 × 沈降',
    test: (r) => isNum(r.advection) && isNum(r.lift) && r.advection <= 0.3 && r.lift <= 0.4,
  },
  {
    id: 'warm-ascent',
    label: '暖気の移流 × 上昇',
    test: (r) => isNum(r.advection) && isNum(r.lift) && r.advection >= 0.7 && r.lift >= 0.6,
  },
];

// 型ごと・特徴量ごとの { n, median, p25, p75 } の表。型に入る標本は conditionsRank で判定する。
export function regimeTable(samples, features) {
  features.forEach(assertLinear);
  return REGIMES.map((regime) => {
    const rows = samples.filter((s) => s.conditionsRank && regime.test(s.conditionsRank));
    const stats = {};
    for (const feature of features) {
      const { n, median, p25, p75 } = summarize(rows.map((s) => s.features?.[feature]));
      stats[feature] = { n, median, p25, p75 };
    }
    return { id: regime.id, label: regime.label, n: rows.length, stats };
  });
}

// 各条件を、その側の全標本の中での順位へ直して conditionsRank に足した配列を返す。元の配列は書き換えない。
export function withConditionRanks(samples, conditionNames) {
  conditionNames.forEach(assertLinear);
  const ranks = new Map(conditionNames.map((name) => [
    name,
    rankNormalize(samples.map((s) => s.conditions?.[name] ?? null)),
  ]));
  return samples.map((s, i) => {
    const conditionsRank = {};
    for (const name of conditionNames) conditionsRank[name] = ranks.get(name)[i];
    return { ...s, conditionsRank };
  });
}
