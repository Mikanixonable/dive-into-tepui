// 描画を使わない速い監査: 生成の気象状態そのものと、雲の物理量(ISCCP 分類)を実写と比べる。
// 生成器(src/render/cloud)を直すフィードバックループの主指標 — 比較(compare)は撮影と
// ブートストラップで 15 分以上かかり、陸では地表の明るさが雲の信号へ混ざる。ここは撮影を
// 使わず、気象状態の読み出しだけで回す(光学的厚み × 雲頂高度なので陸でも使える)。
//
// 使い方: CLOUD_LAB_PORT=8841 CLOUD_LAB_DEBUG_PORT=9541 node tools/cloud-regime-audit.mjs
//   --reuse で気象状態の書き出しを省く(既定は子プロセスで書き出し直す)。
//   --bootstrap=N で場面単位ブートストラップの回数(既定 50。0 で見出しの信頼区間なし)。
// 出力: .cloud-detail/regime/audit/report.md・report.json・history/<UTC 時刻>-<commit>.json
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  VARIOGRAM_EDGES_KM,
  explainedVariance,
  mulberry32,
  pearson,
  quantileSorted,
  rankNormalize,
  responseDistance,
  variogramDistance,
} from './cloud-regime-metrics.mjs';
import { generatedPhysical, generatedTileConditions } from './cloud-regime-generated.mjs';
import { loadGeneratedWeather } from './cloud-regime-weather.mjs';
import {
  gitHead, previousReportName, readReport, saveReport,
} from './cloud-report-history.mjs';

const root = path.resolve(import.meta.dirname, '..');
const regimeDir = path.join(root, '.cloud-detail', 'regime');
const auditDir = path.join(regimeDir, 'audit');
const historyDir = path.join(auditDir, 'history');
const teacherConditionsFile = path.join(regimeDir, 'teacher-conditions.json');
const teacherPhysicalFile = path.join(regimeDir, 'teacher-physical.json');
const weatherManifestFile = path.join(regimeDir, 'generated-weather', 'manifest.json');
const weatherToolFile = path.join(root, 'tools', 'cloud-regime-weather.mjs');

// (A) 物理単位の揃う条件(周辺分布を物理量のまま比べる)。
const WEATHER_CONDITIONS = ['slp', 'cyclonic', 'lift', 'windLow', 'windUp', 'shear'];
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
// (B) 区分ごとに平均する物理量の割合(実写の physical と同じキー)。
const CLASS_FEATURES = [
  'cloudFrac', 'topLowFrac', 'topMiddleFrac', 'topHighFrac',
  'deepFrac', 'highThinFrac', 'tauThinFrac', 'tauMidFrac', 'tauThickFrac',
];
// (C) 応答を比べる条件と特徴量(単位の揃わない条件は順位の比較になる)。
const CONDITIONS = [
  'lift', 'cyclonic', 'slp', 'advection', 'front', 'humidLow', 'humidUp', 'windLow', 'shear',
];
const FEATURES = [
  'cloudFrac', 'topLowFrac', 'topMiddleFrac', 'topHighFrac', 'deepFrac', 'highThinFrac', 'thickShare',
];
// (D) バリオグラムの距離を出す特徴量。
const VARIOGRAM_FEATURES = ['cloudFrac', 'topHighFrac', 'topLowFrac'];
// 区分の並び(cloud-regime-physical.mjs と同じ順 — 表を揃えるため)。
const CATEGORY_ORDER = [
  'tropical-sea', 'temperate-sea', 'highlat-sea', 'tropical-land', 'temperate-land', 'highlat-land', 'arid-land',
];
// 緯度帯の切り分け。緯度の交絡を除くため、(C) は全域に加えてこの 2 帯でも出す。
const BANDS = [
  { id: 'all', label: '全域', test: () => true },
  { id: 'tropics', label: '熱帯(|緯度| < 25)', test: (lat) => Math.abs(lat) < 25 },
  { id: 'extratropics', label: '中高緯度(|緯度| ≥ 25)', test: (lat) => Math.abs(lat) >= 25 },
];
// (A) と順位相関は、海のタイル(land < 0.2)を緯度帯 3 つへ分けて出す。陸は地表の明るさと
// 地形の効果が混ざるので、気象そのものの分布を見るのは海で行う。
const SEA_LAND_MAX = 0.2;
const SEA_BANDS = [
  { id: 'tropical', label: '熱帯(|緯度| < 25°)', test: (lat) => Math.abs(lat) < 25 },
  { id: 'temperate', label: '中緯度(25〜55°)', test: (lat) => Math.abs(lat) >= 25 && Math.abs(lat) < 55 },
  { id: 'highlat', label: '高緯度(55°〜)', test: (lat) => Math.abs(lat) >= 55 },
];
// 順位相関を出す条件の対(帯 × 海、実写と生成を並べる)。
const CORRELATION_PAIRS = [
  ['lift', 'slp'],
  ['lift', 'cyclonic'],
  ['lift', 'advection'],
  ['lift', 'humidLow'],
  ['humidLow', 'slp'],
  ['humidLow', 'cyclonic'],
];
// 実写のタイルの有効率の下限(physical.mjs の MIN_VALID_FRAC と同じ値で絞る)。
const MIN_VALID_FRAC = 0.5;
const BOOTSTRAP_RESAMPLES = 50;
const BOOTSTRAP_SEED = 2026;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const meanOf = (values) => values.reduce((s, v) => s + v, 0) / values.length;
const fmt = (v, digits = 3) => (isNum(v) ? Number(v.toPrecision(digits)) : '—');
const padL = (text, width) => String(text).padEnd(width);
const padR = (text, width) => String(text).padStart(width);

// physical(ISCCP 分類の割合)から統計へ渡す特徴量。派生量は両側で同じ式:
// thickShare = τ厚の割合 ÷ 雲の τ の合計、lowShare/highShare = 雲頂の段 ÷ 雲の割合。
function physicalFeatures(p) {
  const tauTotal = (p.tauThinFrac ?? 0) + (p.tauMidFrac ?? 0) + (p.tauThickFrac ?? 0);
  return {
    cloudFrac: p.cloudFrac,
    topLowFrac: p.topLowFrac,
    topMiddleFrac: p.topMiddleFrac,
    topHighFrac: p.topHighFrac,
    deepFrac: p.deepFrac,
    highThinFrac: p.highThinFrac,
    tauThinFrac: p.tauThinFrac,
    tauMidFrac: p.tauMidFrac,
    tauThickFrac: p.tauThickFrac,
    thickShare: tauTotal >= 0.05 ? (p.tauThickFrac ?? 0) / tauTotal : null,
    lowShare: isNum(p.cloudFrac) && p.cloudFrac >= 0.05 ? p.topLowFrac / p.cloudFrac : null,
    highShare: isNum(p.cloudFrac) && p.cloudFrac >= 0.05 ? p.topHighFrac / p.cloudFrac : null,
  };
}

// 気象状態の書き出しを子プロセスで走らせる(webpack のビルドを含む)。
function writeGeneratedWeather() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [weatherToolFile], { cwd: root, stdio: 'inherit', env: process.env });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`気象状態の書き出しが code ${code} で終わった`))));
    child.on('error', reject);
  });
}

// 値の並びの分位点(実写と同じ type 7)。
function quantilesOf(values, fractions = QUANTILES) {
  const sorted = values.filter(isNum).sort((a, b) => a - b);
  return fractions.map((f) => quantileSorted(sorted, f));
}

// (A) 1 条件の周辺分布と距離。距離 = 5 分位の差の絶対値の平均 ÷ 実写の (p95 − p5)。
function marginalRow(realSamples, genSamples, condition) {
  const rq = quantilesOf(realSamples.map((s) => s.conditions?.[condition]));
  const gq = quantilesOf(genSamples.map((s) => s.conditions?.[condition]));
  const span = isNum(rq[0]) && isNum(rq[4]) ? rq[4] - rq[0] : null;
  const diffs = rq.map((r, i) => (isNum(r) && isNum(gq[i]) ? Math.abs(gq[i] - r) : null)).filter(isNum);
  return {
    condition,
    real: rq,
    generated: gq,
    distance: span > 0 && diffs.length > 0 ? meanOf(diffs) / span : null,
  };
}

// (A) の lift だけの補足。実写が 0 を中心に対称なのに対し、生成はほぼ沈降しないことの指標。
function liftExtra(samples) {
  const lifts = samples.map((s) => s.conditions?.lift).filter(isNum);
  return {
    mean: lifts.length > 0 ? meanOf(lifts) : null,
    sinkFrac: lifts.length > 0 ? lifts.filter((v) => v < 0).length / lifts.length : null,
  };
}

// 海のタイルの緯度帯。SEA_BANDS の添字を返し、海でない(または緯度・陸割合の無い)タイルは −1。
function seaBandOf(sample) {
  const land = sample.conditions?.land;
  if (!isNum(land) || land >= SEA_LAND_MAX) return -1;
  const lat = sample.conditions?.lat ?? sample.lat;
  if (!isNum(lat)) return -1;
  return SEA_BANDS.findIndex((band) => band.test(lat));
}

// 条件どうしの順位相関。側ごとに標本内の順位 0..1 へ直してからピアソン(Spearman)。
function spearman(samples, conditionA, conditionB) {
  const rx = rankNormalize(samples.map((s) => s.conditions?.[conditionA]));
  const ry = rankNormalize(samples.map((s) => s.conditions?.[conditionB]));
  const xs = [];
  const ys = [];
  for (let i = 0; i < rx.length; i++) {
    if (isNum(rx[i]) && isNum(ry[i])) {
      xs.push(rx[i]);
      ys.push(ry[i]);
    }
  }
  return pearson(xs, ys);
}

// (B) 1 区分の、9 個の物理量の割合の平均(実写 / 生成)と距離 = 両方ある量の |生成 − 実写| の平均。
function classRow(realSamples, genSamples, category) {
  const rf = realSamples.filter((s) => s.category === category);
  const gf = genSamples.filter((s) => s.category === category);
  const meanFeature = (samples, key) => {
    const vals = samples.map((s) => s.features?.[key]).filter(isNum);
    return vals.length > 0 ? meanOf(vals) : null;
  };
  const real = CLASS_FEATURES.map((k) => meanFeature(rf, k));
  const generated = CLASS_FEATURES.map((k) => meanFeature(gf, k));
  const diffs = real.map((r, i) => (isNum(r) && isNum(generated[i]) ? Math.abs(generated[i] - r) : null)).filter(isNum);
  return { category, real, generated, n: { real: rf.length, generated: gf.length }, distance: diffs.length > 0 ? meanOf(diffs) : null };
}

// (C) 1 帯の応答の表。条件 × 特徴量ごとの bias・contrast・gainRatio・corr と両側の η²。
function responseTable(realSamples, genSamples) {
  const rows = [];
  for (const condition of CONDITIONS) {
    for (const feature of FEATURES) {
      const d = responseDistance(realSamples, genSamples, condition, feature);
      rows.push({
        condition,
        feature,
        bias: d.bias,
        contrast: d.contrast,
        gainRatio: d.gainRatio,
        corr: d.corr,
        etaReal: explainedVariance(realSamples, condition, feature),
        etaGenerated: explainedVariance(genSamples, condition, feature),
      });
    }
  }
  return rows;
}

// (D) バリオグラムの距離(特徴量ごと)。
function variogramTable(realSamples, genSamples) {
  return VARIOGRAM_FEATURES.map((feature) => {
    const vd = variogramDistance(realSamples, genSamples, feature);
    return { feature, distance: vd.distance, rangeRatio: vd.rangeRatio };
  });
}

// --- 速いブートストラップ -----------------------------------------------------
// 生成の標本は 場面 × 8 時刻 × 64 タイルで 10 万を超える。metrics の関数をそのまま
// 50 回回すと、引き出しごとの整列だけで数分かかる。そこで見出しの計算だけ、
// 「標本全体を一度だけ値で並べた添字列」を側・キーごとに用意し、場面単位の復元抽出を
// 場面の重複回数の配列で表して、並びを走査しながら重みぶん要素を繰り返す形にする —
// 抽出で絞っても値の順序は保存されるので、引き出しごとの再整列が要らない。
// 式は metrics の responseDistance・explainedVariance・variogramDistance と同じで、
// 重み 1 の恒等抽出が metrics の関数の結果と一致することを main で検算する。

// 見出しの点数の名前(順は出力の並び)。
const SCORE_KEYS = [
  'weather', 'classes', 'responseContrast', 'responseBias', 'responseGain', 'explainedGap', 'variogram',
];

// 側(実写 or 生成)の標本へ、事前整列と場面ごとの集計を付ける。
function prepareSide(samples) {
  const sceneIds = [];
  const sceneIndex = new Map();
  const sampleScene = new Int32Array(samples.length);
  const seaBand = new Int8Array(samples.length);
  samples.forEach((s, i) => {
    if (!sceneIndex.has(s.scene)) {
      sceneIndex.set(s.scene, sceneIds.length);
      sceneIds.push(s.scene);
    }
    sampleScene[i] = sceneIndex.get(s.scene);
    seaBand[i] = seaBandOf(s);
  });
  const scenes = sceneIds.map((id) => ({
    id,
    category: samples.find((s) => s.scene === id)?.category ?? null,
    members: [],
  }));
  samples.forEach((s, i) => scenes[sampleScene[i]].members.push(i));
  // 値の並び(条件・特徴量の和集合)と、その値で並べた添字列。
  const keys = [...new Set([...CONDITIONS, ...WEATHER_CONDITIONS, ...FEATURES, ...CLASS_FEATURES])];
  const values = {};
  const orders = {};
  for (const key of keys) {
    const vals = new Float64Array(samples.length).fill(NaN);
    samples.forEach((s, i) => {
      const v = s.conditions?.[key] ?? s.features?.[key];
      if (isNum(v)) vals[i] = v;
    });
    values[key] = vals;
    orders[key] = Int32Array.from(
      samples.map((_, i) => i).filter((i) => Number.isFinite(vals[i])).sort((a, b) => vals[a] - vals[b]),
    );
  }
  // 場面ごとの集計。バリオグラムの対の和・標本の和と二乗和(分散)・区分の平均の和。
  const sceneStats = scenes.map((scene) => {
    const stats = { classes: {}, variograms: {} };
    for (const key of CLASS_FEATURES) {
      const vals = scene.members.map((i) => values[key]?.[i]).filter(Number.isFinite);
      stats.classes[key] = { sum: vals.reduce((s, v) => s + v, 0), count: vals.length };
    }
    for (const key of VARIOGRAM_FEATURES) {
      const vals = scene.members
        .map((i) => ({ v: values[key][i], s: samples[i] }))
        .filter((e) => Number.isFinite(e.v));
      const bandCount = VARIOGRAM_EDGES_KM.length - 1;
      const bandSum = new Float64Array(bandCount);
      const bandCnt = new Float64Array(bandCount);
      for (let i = 0; i < vals.length; i++) {
        for (let j = i + 1; j < vals.length; j++) {
          const distance = Math.hypot(vals[i].s.xKm - vals[j].s.xKm, vals[i].s.yKm - vals[j].s.yKm);
          for (let b = 0; b < bandCount; b++) {
            const last = b === bandCount - 1;
            if (distance >= VARIOGRAM_EDGES_KM[b] && (distance < VARIOGRAM_EDGES_KM[b + 1] || (last && distance <= VARIOGRAM_EDGES_KM[b + 1]))) {
              bandSum[b] += (vals[i].v - vals[j].v) ** 2;
              bandCnt[b]++;
              break;
            }
          }
        }
      }
      stats.variograms[key] = {
        bandSum,
        bandCnt,
        sum: vals.reduce((s, e) => s + e.v, 0),
        sq: vals.reduce((s, e) => s + e.v * e.v, 0),
        count: vals.length,
      };
    }
    return stats;
  });
  return { samples, scenes, sampleScene, seaBand, values, orders, sceneStats };
}

// 抽出の標本のうち、key と feature の両方が有限で場面の重みが正の要素の重みの合計
// (= 抽出された標本数。feature === null なら key の有限さだけで数える)。
// band !== null なら seaBand === band の海のタイルだけを数える。
function drawCount(side, key, feature, weights, band = null) {
  const featureValues = feature === null ? null : side.values[feature];
  let n = 0;
  for (const i of side.orders[key]) {
    if (band !== null && side.seaBand[i] !== band) continue;
    const w = weights[side.sampleScene[i]];
    if (w > 0 && (featureValues === null || Number.isFinite(featureValues[i]))) n += w;
  }
  return n;
}

// 抽出された標本の、key の値で並べた列を順位で bins 等分したときの
// ビンごとの個数・和・二乗和・条件の両端 — metrics の responseCurve と同じビンの切り方。
// 添字列は実体化せず、orders[key] を 2 回走る(個数 → 累積)。
function binsOfDraw(side, key, feature, weights, bins = 5) {
  const keyValues = side.values[key];
  const featureValues = feature === null ? null : side.values[feature];
  const n = drawCount(side, key, feature, weights);
  const out = Array.from({ length: bins }, () => ({ n: 0, sum: 0, sq: 0, lo: null, hi: null }));
  if (n === 0) return out.map((cell) => ({ ...cell, mean: null }));
  let rank = 0;
  for (const i of side.orders[key]) {
    const w = weights[side.sampleScene[i]];
    if (w <= 0 || (featureValues !== null && !Number.isFinite(featureValues[i]))) continue;
    const v = featureValues ?? keyValues;
    for (let k = 0; k < w; k++) {
      const cell = out[Math.floor((rank * bins) / n)];
      cell.n++;
      cell.sum += v[i];
      cell.sq += v[i] * v[i];
      const c = keyValues[i];
      if (cell.lo === null) cell.lo = c;
      cell.hi = c;
      rank++;
    }
  }
  return out.map((cell) => ({ ...cell, mean: cell.n > 0 ? cell.sum / cell.n : null }));
}

// 抽出の key の値列の分位点(type 7)。添字列を実体化せず、重みの累積で 1 回の走査で取る。
// band !== null なら seaBand === band の海のタイルだけから取る。
function quantileOfDraw(side, key, weights, q, band = null) {
  const keyValues = side.values[key];
  const n = drawCount(side, key, null, weights, band);
  if (n === 0) return null;
  const position = (n - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  let acc = 0;
  let vLo = null;
  let vHi = null;
  for (const i of side.orders[key]) {
    if (band !== null && side.seaBand[i] !== band) continue;
    const w = weights[side.sampleScene[i]];
    if (w <= 0) continue;
    const next = acc + w;
    if (vLo === null && next > lo) vLo = keyValues[i];
    if (next > hi) {
      vHi = keyValues[i];
      break;
    }
    acc = next;
  }
  vHi ??= vLo;
  if (vLo === null) return null;
  return vLo + (vHi - vLo) * (position - lo);
}

// metrics の responseDistance と同じ式(並びを引数で受ける版)。
function responseOfDraw(realSide, genSide, condition, feature, wReal, wGen) {
  const realBins = binsOfDraw(realSide, condition, feature, wReal);
  const genBins = binsOfDraw(genSide, condition, feature, wGen);
  // scale は実写の feature の四分位範囲 ÷ 1.349。
  const p25 = quantileOfDraw(realSide, feature, wReal, 0.25);
  const p75 = quantileOfDraw(realSide, feature, wReal, 0.75);
  const iqr = isNum(p25) && isNum(p75) ? p75 - p25 : null;
  const scale = iqr !== null && iqr / 1.349 > 0 ? iqr / 1.349 : 1;
  const pairs = realBins.map((r, i) => ({ r, g: genBins[i] })).filter(({ r, g }) => r.n > 0 && g.n > 0);
  const d = pairs.map(({ r, g }) => (g.mean - r.mean) / scale);
  const bias = d.length > 0 ? meanOf(d) : null;
  const contrast = d.length > 0 ? Math.sqrt(meanOf(d.map((v) => (v - bias) ** 2))) : null;
  const rangeOf = (bins) => {
    const means = bins.filter((b) => b.n > 0).map((b) => b.mean);
    return means.length > 0 ? Math.max(...means) - Math.min(...means) : null;
  };
  const realRange = rangeOf(realBins);
  const generatedRange = rangeOf(genBins);
  return {
    bias,
    contrast,
    gainRatio: realRange > 0 ? generatedRange / realRange : null,
    corr: pearson(pairs.map(({ r }) => r.mean), pairs.map(({ g }) => g.mean)),
  };
}

// metrics の explainedVariance と同じ式(ビン間の分散 ÷ 全分散)。
function explainedOfDraw(side, condition, feature, weights) {
  const bins = binsOfDraw(side, condition, feature, weights);
  const n = bins.reduce((s, b) => s + b.n, 0);
  if (n === 0) return null;
  const totalSum = bins.reduce((s, b) => s + b.sum, 0);
  const totalSq = bins.reduce((s, b) => s + b.sq, 0);
  const total = totalSq - (totalSum * totalSum) / n;
  if (total <= 0) return null;
  const grand = totalSum / n;
  const between = bins.reduce((s, b) => s + b.n * (b.mean - grand) ** 2, 0);
  return between / total;
}

// metrics の variogramDistance と同じ式(場面ごとの対の和を重みで畳む)。
function variogramOfDraw(realSide, genSide, feature, wReal, wGen) {
  const accumulate = (side, weights) => {
    const bandCount = VARIOGRAM_EDGES_KM.length - 1;
    const bandSum = new Float64Array(bandCount);
    const bandCnt = new Float64Array(bandCount);
    let sum = 0;
    let sq = 0;
    let n = 0;
    side.scenes.forEach((scene, s) => {
      const w = weights[s];
      if (w <= 0) return;
      const st = side.sceneStats[s].variograms[feature];
      for (let b = 0; b < bandCount; b++) {
        bandSum[b] += w * st.bandSum[b];
        bandCnt[b] += w * st.bandCnt[b];
      }
      sum += w * st.sum;
      sq += w * st.sq;
      n += w * st.count;
    });
    const totalVariance = n > 0 ? (sq - (sum * sum) / n) / n : null;
    return { bandSum, bandCnt, totalVariance };
  };
  const real = accumulate(realSide, wReal);
  const gen = accumulate(genSide, wGen);
  if (!(real.totalVariance > 0)) return null;
  const logs = [];
  for (let b = 0; b < real.bandSum.length; b++) {
    const rg = real.bandCnt[b] > 0 ? real.bandSum[b] / real.bandCnt[b] / 2 / real.totalVariance : null;
    const gg = gen.bandCnt[b] > 0 ? gen.bandSum[b] / gen.bandCnt[b] / 2 / real.totalVariance : null;
    if (rg > 0 && gg > 0) logs.push(Math.abs(Math.log(gg / rg)));
  }
  return logs.length > 0 ? meanOf(logs) : null;
}

// 抽出 1 回ぶんの見出しの点数 7 つ(headlineScores と同じ項目・同じ式)。
function scoresOfDraw(realSide, genSide, wReal, wGen) {
  // (A) 帯 × 海のタイルごとの周辺分布の距離。
  const weatherDistances = [];
  for (let band = 0; band < SEA_BANDS.length; band++) {
    for (const condition of WEATHER_CONDITIONS) {
      const rq = QUANTILES.map((q) => quantileOfDraw(realSide, condition, wReal, q, band));
      const gq = QUANTILES.map((q) => quantileOfDraw(genSide, condition, wGen, q, band));
      const span = isNum(rq[0]) && isNum(rq[4]) ? rq[4] - rq[0] : null;
      const diffs = rq.map((r, i) => (isNum(r) && isNum(gq[i]) ? Math.abs(gq[i] - r) : null)).filter(isNum);
      if (span > 0 && diffs.length > 0) weatherDistances.push(meanOf(diffs) / span);
    }
  }
  // (B)
  const classDistances = [];
  for (const category of CATEGORY_ORDER) {
    const diffs = [];
    for (const key of CLASS_FEATURES) {
      const meanKey = (side, weights) => {
        let sum = 0;
        let n = 0;
        side.scenes.forEach((scene, s) => {
          if (scene.category !== category || weights[s] <= 0) return;
          const st = side.sceneStats[s].classes[key];
          sum += weights[s] * st.sum;
          n += weights[s] * st.count;
        });
        return n > 0 ? sum / n : null;
      };
      const r = meanKey(realSide, wReal);
      const g = meanKey(genSide, wGen);
      if (isNum(r) && isNum(g)) diffs.push(Math.abs(g - r));
    }
    if (diffs.length > 0) classDistances.push(meanOf(diffs));
  }
  // (C)
  let contrastSum = 0;
  let biasSum = 0;
  let responseN = 0;
  const gainLogs = [];
  let etaSum = 0;
  let etaN = 0;
  for (const condition of CONDITIONS) {
    for (const feature of FEATURES) {
      const d = responseOfDraw(realSide, genSide, condition, feature, wReal, wGen);
      if (isNum(d.contrast) && isNum(d.bias)) {
        contrastSum += d.contrast;
        biasSum += Math.abs(d.bias);
        responseN++;
      }
      if (isNum(d.gainRatio) && d.gainRatio > 0) gainLogs.push(Math.abs(Math.log(d.gainRatio)));
      const er = explainedOfDraw(realSide, condition, feature, wReal);
      const eg = explainedOfDraw(genSide, condition, feature, wGen);
      if (isNum(er) && isNum(eg)) {
        etaSum += Math.abs(eg - er);
        etaN++;
      }
    }
  }
  // (D)
  const variogramDistances = VARIOGRAM_FEATURES
    .map((feature) => variogramOfDraw(realSide, genSide, feature, wReal, wGen))
    .filter(isNum);
  const median = (values) => quantileSorted([...values].sort((a, b) => a - b), 0.5);
  return {
    weather: weatherDistances.length > 0 ? meanOf(weatherDistances) : null,
    classes: classDistances.length > 0 ? meanOf(classDistances) : null,
    responseContrast: responseN > 0 ? contrastSum / responseN : null,
    responseBias: responseN > 0 ? biasSum / responseN : null,
    responseGain: gainLogs.length > 0 ? median(gainLogs) : null,
    explainedGap: etaN > 0 ? etaSum / etaN : null,
    variogram: variogramDistances.length > 0 ? meanOf(variogramDistances) : null,
  };
}

// 正確な見出しの点数(metrics の関数をそのまま使う版。速い版の検算の正本でもある)。
function headlineScores(realSamples, genSamples) {
  const weatherDistances = [];
  for (let band = 0; band < SEA_BANDS.length; band++) {
    const realSea = realSamples.filter((s) => seaBandOf(s) === band);
    const genSea = genSamples.filter((s) => seaBandOf(s) === band);
    for (const condition of WEATHER_CONDITIONS) {
      const distance = marginalRow(realSea, genSea, condition).distance;
      if (isNum(distance)) weatherDistances.push(distance);
    }
  }
  const classDistances = CATEGORY_ORDER
    .map((category) => classRow(realSamples, genSamples, category).distance)
    .filter(isNum);
  let contrastSum = 0;
  let biasSum = 0;
  let responseN = 0;
  const gainLogs = [];
  let etaSum = 0;
  let etaN = 0;
  for (const condition of CONDITIONS) {
    for (const feature of FEATURES) {
      const d = responseDistance(realSamples, genSamples, condition, feature);
      if (isNum(d.contrast) && isNum(d.bias)) {
        contrastSum += d.contrast;
        biasSum += Math.abs(d.bias);
        responseN++;
      }
      if (isNum(d.gainRatio) && d.gainRatio > 0) gainLogs.push(Math.abs(Math.log(d.gainRatio)));
      const er = explainedVariance(realSamples, condition, feature);
      const eg = explainedVariance(genSamples, condition, feature);
      if (isNum(er) && isNum(eg)) {
        etaSum += Math.abs(eg - er);
        etaN++;
      }
    }
  }
  const variogramDistances = variogramTable(realSamples, genSamples)
    .map((v) => v.distance)
    .filter(isNum);
  const median = (values) => quantileSorted([...values].sort((a, b) => a - b), 0.5);
  return {
    weather: weatherDistances.length > 0 ? meanOf(weatherDistances) : null,
    classes: classDistances.length > 0 ? meanOf(classDistances) : null,
    responseContrast: responseN > 0 ? contrastSum / responseN : null,
    responseBias: responseN > 0 ? biasSum / responseN : null,
    responseGain: gainLogs.length > 0 ? median(gainLogs) : null,
    explainedGap: etaN > 0 ? etaSum / etaN : null,
    variogram: variogramDistances.length > 0 ? meanOf(variogramDistances) : null,
  };
}

// 場面単位の復元抽出で、見出しの点数 7 つの中央値と 5〜95% 点を取る。
function bootstrapScores(realSide, genSide, resamples, seed = BOOTSTRAP_SEED) {
  const rng = mulberry32(seed);
  const draw = (sceneCount) => {
    const weights = new Int32Array(sceneCount);
    for (let i = 0; i < sceneCount; i++) weights[Math.floor(rng() * sceneCount)]++;
    return weights;
  };
  const keys = SCORE_KEYS;
  const draws = Object.fromEntries(keys.map((k) => [k, []]));
  for (let r = 0; r < resamples; r++) {
    const scores = scoresOfDraw(realSide, genSide, draw(realSide.scenes.length), draw(genSide.scenes.length));
    for (const key of keys) if (isNum(scores[key])) draws[key].push(scores[key]);
  }
  return Object.fromEntries(Object.entries(draws).map(([key, values]) => {
    values.sort((a, b) => a - b);
    return [key, {
      median: quantileSorted(values, 0.5),
      p05: quantileSorted(values, 0.05),
      p95: quantileSorted(values, 0.95),
      draws: values.length,
    }];
  }));
}

function mdTable(headerCells, rows) {
  return [
    `| ${headerCells.join(' | ')} |`,
    `| ${headerCells.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const reuse = args.includes('--reuse');
  const bootstrapArg = args.find((a) => a.startsWith('--bootstrap='));
  const bootstrapResamples = bootstrapArg === undefined ? BOOTSTRAP_RESAMPLES : Number(bootstrapArg.split('=')[1]);

  if (!reuse) {
    console.log('=== 気象状態の書き出し(node tools/cloud-regime-weather.mjs)===');
    await writeGeneratedWeather();
  }
  const computeStart = Date.now();

  // --- 気象状態と標本の読み込み ---
  const weatherManifest = JSON.parse(readFileSync(weatherManifestFile, 'utf8'));
  const hoursList = weatherManifest.hours;
  const weatherByHour = new Map(hoursList.map((h) => [h, loadGeneratedWeather(h)]));
  // 物理量の読み出し(cumulusTau ほか 4 チャンネル)が入っていない古い気象状態では、
  // 生成の雲が全部晴天へ畳まれて意味の無い比較になる。--reuse のときだけ起こりうるので、
  // 黙って進まず書き出し直しを求める。
  const PHYSICAL_CHANNELS = ['cumulusTau', 'cirrusTau', 'cumulusTopM', 'cirrusTopM'];
  if (!PHYSICAL_CHANNELS.every((c) => weatherManifest.channels.includes(c))) {
    throw new Error(`気象状態に物理量のチャンネル(${PHYSICAL_CHANNELS.join(', ')})が無い`
      + ' — --reuse を外して書き出し直す');
  }
  const teacherConditions = JSON.parse(readFileSync(teacherConditionsFile, 'utf8'));
  const teacherPhysical = JSON.parse(readFileSync(teacherPhysicalFile, 'utf8'));
  const physicalByKey = new Map(teacherPhysical.tiles.map((t) => [`${t.scene}|${t.tile}`, t]));
  const categoryOf = new Map(teacherConditions.scenes.map((s) => [s.scene, s.category]));

  // 実写の標本: 条件と物理量を (scene, tile) で結ぶ(両方ある場面だけ、有効率 <0.5 は外す)。
  const real = [];
  for (const t of teacherConditions.tiles) {
    const p = physicalByKey.get(`${t.scene}|${t.tile}`);
    if (p === undefined || !(p.physical.validFrac >= MIN_VALID_FRAC)) continue;
    real.push({
      side: 'real',
      scene: t.scene,
      tile: t.tile,
      xKm: t.xKm,
      yKm: t.yKm,
      lat: t.lat,
      lon: t.lon,
      category: categoryOf.get(t.scene) ?? null,
      conditions: t.conditions,
      features: physicalFeatures(p.physical),
    });
  }
  const realSceneIds = new Set(real.map((s) => s.scene));
  const scenes = teacherConditions.scenes.filter((s) => realSceneIds.has(s.scene));
  if (scenes.length === 0) throw new Error('条件と物理量の両方のある場面が無い');

  // 生成の標本: 同じ場面の緯度経度で、8 時刻すべてのタイルの条件と物理量。
  const generated = [];
  for (const scene of scenes) {
    for (const hours of hoursList) {
      const weather = weatherByHour.get(hours);
      const sceneId = `${scene.scene}@h${hours}`;
      for (const tile of generatedTileConditions(scene, weather)) {
        const physical = generatedPhysical(weather, scene.latitude, scene.longitude, tile.xKm, tile.yKm);
        generated.push({
          ...tile,
          scene: sceneId,
          category: scene.category,
          features: physicalFeatures(physical),
        });
      }
    }
  }
  console.log(`標本: 実写 ${scenes.length} 場面・${real.length} タイル / 生成 ${scenes.length} 場面 × ${hoursList.length} 時刻・${generated.length} タイル`);

  // --- 表 ---
  // (A) 気象の周辺分布と条件どうしの順位相関は、帯 × 海のタイルで出す。
  const marginalsByBand = SEA_BANDS.map((band, index) => {
    const realSea = real.filter((s) => seaBandOf(s) === index);
    const genSea = generated.filter((s) => seaBandOf(s) === index);
    return {
      band: band.id,
      label: band.label,
      n: { real: realSea.length, generated: genSea.length },
      rows: WEATHER_CONDITIONS.map((condition) => ({
        ...marginalRow(realSea, genSea, condition),
        extra: condition === 'lift' ? { real: liftExtra(realSea), generated: liftExtra(genSea) } : null,
      })),
      correlations: CORRELATION_PAIRS.map(([a, b]) => ({
        pair: `${a}×${b}`,
        real: spearman(realSea, a, b),
        generated: spearman(genSea, a, b),
      })),
    };
  });
  const classes = CATEGORY_ORDER
    .filter((c) => [...categoryOf.values()].includes(c))
    .map((category) => classRow(real, generated, category));
  const response = {};
  for (const band of BANDS) {
    const realBand = real.filter((s) => band.test(s.conditions?.lat ?? s.lat));
    const genBand = generated.filter((s) => band.test(s.conditions?.lat ?? s.lat));
    response[band.id] = { n: { real: realBand.length, generated: genBand.length }, rows: responseTable(realBand, genBand) };
  }
  const variograms = variogramTable(real, generated);

  // --- 見出しの点数(正確版)と、速い版の一致の検算、ブートストラップ ---
  const scores = headlineScores(real, generated);
  const realSide = prepareSide(real);
  const genSide = prepareSide(generated);
  const identity = scoresOfDraw(
    realSide, genSide,
    new Int32Array(realSide.scenes.length).fill(1),
    new Int32Array(genSide.scenes.length).fill(1),
  );
  for (const key of Object.keys(scores)) {
    if (isNum(scores[key]) !== isNum(identity[key])
      || (isNum(scores[key]) && Math.abs(identity[key] - scores[key]) > 1e-9)) {
      throw new Error(`速いブートストラップが metrics と違う: ${key} ${identity[key]} != ${scores[key]}`);
    }
  }
  const bootstrap = bootstrapResamples > 0 ? bootstrapScores(realSide, genSide, bootstrapResamples) : null;

  // --- レポート ---
  const generatedAt = new Date().toISOString();
  const commit = gitHead(root);
  let srcDirty = null;
  try {
    srcDirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  } catch { /* git が読めない環境では null のまま */ }
  const report = {
    meta: {
      tool: 'cloud-regime-audit',
      generatedAt,
      gitHead: commit,
      commit,
      srcDirty,
      weatherGeneratedAt: weatherManifest.generatedAt,
      teacherGeneratedAt: teacherConditions.generatedAt,
      physicalGeneratedAt: teacherPhysical.generatedAt,
      scenes: { real: scenes.length, generated: scenes.length * hoursList.length },
      tiles: { real: real.length, generated: generated.length },
      hours: hoursList,
      bootstrapResamples,
      elapsedMs: Date.now() - computeStart,
    },
    scores,
    bootstrap,
    marginalsByBand,
    classes,
    response,
    variograms,
  };
  // 履歴の前回は、今回分を書く前に取っておく(書いてからでは自分自身が最新になる)。
  const previous = previousReportName(historyDir);
  const previousScores = previous === undefined ? null : readReport(historyDir, previous)?.scores ?? null;
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, 'report.json'), `${JSON.stringify(report)}\n`);
  writeFileSync(path.join(auditDir, 'report.md'), buildReportMd(report));
  saveReport(historyDir, report);

  // --- 標準出力(60 行以内) ---
  const out = [];
  out.push(`=== 見出しの点数(小さいほど良い。場面ブートストラップ ${bootstrapResamples} 回、中央値 [5–95%]) ===`);
  const diffText = (key) => {
    const before = previousScores?.[key];
    const now = scores[key];
    return isNum(before) && isNum(now) ? `  前回から ${fmt(now - before)}` : '';
  };
  for (const key of Object.keys(scores)) {
    const b = bootstrap?.[key];
    const ci = b !== null && b !== undefined ? ` [${fmt(b.p05)}–${fmt(b.p95)}]` : '';
    out.push(`${padL(key, 18)} ${padR(fmt(scores[key]), 8)}${ci}${diffText(key)}`);
  }
  out.push('=== (A) 気象の周辺分布 p5 p25 p50 p75 p95(実写 / 生成)と距離 — 帯 × 海のタイル ===');
  for (const section of marginalsByBand) {
    out.push(`--- ${section.label} の海(実写 ${section.n.real} / 生成 ${section.n.generated} タイル)---`);
    for (const m of section.rows) {
      out.push(`${padL(m.condition, 12)} 実写 ${m.real.map((v) => padR(fmt(v), 7)).join(' ')}   距離 ${fmt(m.distance)}`);
      out.push(`${''.padEnd(12)} 生成 ${m.generated.map((v) => padR(fmt(v), 7)).join(' ')}${m.extra === null ? '' : `   平均 実写 ${fmt(m.extra.real.mean)} / 生成 ${fmt(m.extra.generated.mean)}・沈降 実写 ${fmt(m.extra.real.sinkFrac)} / 生成 ${fmt(m.extra.generated.sinkFrac)}`}`);
    }
  }
  out.push('=== 条件どうしの順位相関(帯 × 海、実写 / 生成)===');
  out.push(`${padL('', 15)} ${CORRELATION_PAIRS.map(([a, b]) => padR(`${a}×${b}`, 14)).join(' ')}`);
  for (const section of marginalsByBand) {
    for (const [side, key] of [['実写', 'real'], ['生成', 'generated']]) {
      out.push(`${padL(`${section.band} ${side}`, 15)} ${section.correlations.map((c) => padR(fmt(c[key]), 14)).join(' ')}`);
    }
  }
  out.push('=== (B) 区分ごとの平均(実写 / 生成)と距離 ===');
  out.push(`${padL('', 15)} ${CLASS_FEATURES.map((k) => padR(k.replace('Frac', ''), 8)).join(' ')}   距離`);
  for (const row of classes) {
    out.push(`${padL(row.category, 13)} 実写 ${row.real.map((v) => padR(fmt(v), 8)).join(' ')}   ${fmt(row.distance)}`);
    out.push(`${''.padEnd(13)} 生成 ${row.generated.map((v) => padR(fmt(v), 8)).join(' ')}`);
  }
  const allRows = response.all.rows;
  const topContrast = [...allRows].filter((r) => isNum(r.contrast)).sort((a, b) => b.contrast - a.contrast).slice(0, 10);
  out.push('=== (C) 応答が実写と最も違う(contrast 上位 10、全域) ===');
  for (const r of topContrast) {
    out.push(`${padL(r.condition, 16)} ${padL(r.feature, 13)} contrast ${padR(fmt(r.contrast), 7)} bias ${padR(fmt(r.bias), 7)} gain ${padR(fmt(r.gainRatio), 7)} corr ${padR(fmt(r.corr), 7)}`);
  }
  const lowGain = [...allRows].filter((r) => isNum(r.gainRatio)).sort((a, b) => a.gainRatio - b.gainRatio).slice(0, 10);
  out.push('=== (C) 生成が応答していない(gainRatio 下位 10、全域) ===');
  for (const r of lowGain) {
    out.push(`${padL(r.condition, 16)} ${padL(r.feature, 13)} gain ${padR(fmt(r.gainRatio), 7)} contrast ${padR(fmt(r.contrast), 7)} bias ${padR(fmt(r.bias), 7)} corr ${padR(fmt(r.corr), 7)}`);
  }
  console.log(out.join('\n'));
}

// report.json から report.md(日本語)を組む。
function buildReportMd(report) {
  const { meta, scores, bootstrap, marginalsByBand, classes, response, variograms } = report;
  const lines = [];
  lines.push('# 気象状態と雲の物理量の監査(実写 / 生成)');
  lines.push('');
  lines.push(`- commit: ${meta.commit} · 生成: ${meta.generatedAt} · src/ の未コミット変更: ${meta.srcDirty === null ? '不明' : meta.srcDirty ? 'あり' : 'なし'}`);
  lines.push(`- 実写: ${meta.scenes.real} 場面 / ${meta.tiles.real} タイル · 生成: ${meta.scenes.real} 場面 × ${meta.hours.length} 時刻 / ${meta.tiles.generated} タイル`);
  lines.push(`- 気象状態: ${meta.weatherGeneratedAt} 生成の ${meta.hours.join(', ')} h`);
  lines.push('');
  lines.push(`## 見出しの点数(小さいほど良い。場面ブートストラップ ${meta.bootstrapResamples} 回、中央値 [5–95%])`);
  lines.push('');
  const cell = (key) => {
    const b = bootstrap?.[key];
    return b === null || b === undefined ? fmt(scores[key]) : `${fmt(scores[key])} [${fmt(b.p05)}–${fmt(b.p95)}]`;
  };
  lines.push(mdTable(
    ['点数', 'weather', 'classes', 'responseContrast', 'responseBias', 'responseGain', 'explainedGap', 'variogram'],
    [['値', ...Object.keys(scores).map(cell)]],
  ));
  lines.push('');
  lines.push('## (A) 気象の周辺分布(p5・p25・p50・p75・p95、実写 / 生成)— 帯 × 海のタイル(land < 0.2)');
  lines.push('距離 = 5 分位の差の絶対値の平均 ÷ 実写の (p95 − p5)。lift は平均と沈降しているタイルの割合も。');
  for (const section of marginalsByBand) {
    lines.push('');
    lines.push(`### ${section.label} の海(実写 ${section.n.real} / 生成 ${section.n.generated} タイル)`);
    lines.push(mdTable(
      ['条件', '側', ...QUANTILES.map((q) => `p${q * 100}`), '距離', '平均', '沈降の割合'],
      section.rows.flatMap((m) => [
        [m.condition, '実写', ...m.real.map((v) => fmt(v)), fmt(m.distance), fmt(m.extra?.real.mean), fmt(m.extra?.real.sinkFrac)],
        ['', '生成', ...m.generated.map((v) => fmt(v)), '', fmt(m.extra?.generated.mean), fmt(m.extra?.generated.sinkFrac)],
      ]),
    ));
  }
  lines.push('');
  lines.push('## 条件どうしの順位相関(帯 × 海、実写 / 生成)');
  lines.push('側ごとに標本内の順位へ直してからピアソン(Spearman の ρ)。');
  lines.push(mdTable(
    ['帯', '対', '実写', '生成'],
    marginalsByBand.flatMap((section) => section.correlations.map((c) => [
      section.label, c.pair, fmt(c.real), fmt(c.generated),
    ])),
  ));
  lines.push('');
  lines.push('## (B) 区分ごとの平均(実写 / 生成)');
  lines.push('距離 = 9 個の割合の |生成 − 実写| の平均。');
  lines.push(mdTable(
    ['区分', '側', 'n(実写/生成)', ...CLASS_FEATURES, '距離'],
    classes.flatMap((row) => [
      [row.category, '実写', `${row.n.real}/${row.n.generated}`, ...row.real.map((v) => fmt(v)), fmt(row.distance)],
      ['', '生成', '', ...row.generated.map((v) => fmt(v)), ''],
    ]),
  ));
  for (const band of BANDS) {
    const section = response[band.id];
    lines.push('');
    lines.push(`## (C) 応答 — ${band.label}(実写 ${section.n.real}・生成 ${section.n.generated} タイル)`);
    for (const metric of ['bias', 'contrast', 'gainRatio', 'corr']) {
      lines.push('');
      lines.push(`### ${metric}`);
      lines.push(mdTable(
        ['条件', ...FEATURES],
        CONDITIONS.map((condition) => [
          condition,
          ...FEATURES.map((feature) => fmt(section.rows.find((r) => r.condition === condition && r.feature === feature)?.[metric])),
        ]),
      ));
    }
    lines.push('');
    lines.push('### η²(実写 / 生成)');
    lines.push(mdTable(
      ['条件', '側', ...FEATURES],
      CONDITIONS.flatMap((condition) => {
        const cells = (key) => FEATURES.map((feature) => fmt(section.rows.find((r) => r.condition === condition && r.feature === feature)?.[key]));
        return [[condition, '実写', ...cells('etaReal')], ['', '生成', ...cells('etaGenerated')]];
      }),
    ));
  }
  lines.push('');
  lines.push('## (D) バリオグラムの距離');
  lines.push(mdTable(
    ['特徴量', '距離', '最遠/最近 比(生成÷実写)'],
    variograms.map((v) => [v.feature, fmt(v.distance), fmt(v.rangeRatio)]),
  ));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
