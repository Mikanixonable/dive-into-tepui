// 半透明巻雲の教師の集計。manifest.json の採用点とキャッシュの窓から report.json
// (区分ごとの特徴量の分布・最近中心 leave-one-out の混同行列・scaly の判定要素の
// 区分比較表)と接触シートを書き出す。stage = "report" で呼ぶ。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeChannelPng } from './gray-image.mjs';
import { decodePng } from './png.mjs';
import { linearLuminanceField } from './cloud-detail-field.mjs';
import { OUT_DIR, CLASSES, loadLoopConfig, decodeLayer } from './cloud-translucent-gibs.mjs';
import {
  TRANSLUCENT_CTH_MIN_M, TRANSLUCENT_COT_RANGE, CLASSIFY,
  measureTranslucentWindow, quantileOfSorted, distribution,
} from './cloud-translucent-features.mjs';
import { buildContactSheet } from './cloud-translucent-contact-sheet.mjs';

const manifestFile = path.join(OUT_DIR, 'manifest.json');
const reportFile = path.join(OUT_DIR, 'report.json');

// 特徴ベクトルの次元の定義。名前と取り出し方の対。欠測は null。
export const FEATURE_DIMS = [
  ['cover', (m) => m.shapes.cloudyShare],
  ['toneP50', (m) => m.tone.p50],
  ['gradMean', (m) => m.gradMeanPerKm],
  ['beta', (m) => m.spectrum.beta],
  ['share2_10', (m) => m.spectrum.share2_10],
  ['share10_60', (m) => m.spectrum.share10_60],
  ['share64up', (m) => m.spectrum.share64up],
  ['excessRatio', (m) => m.periodicity.excessRatio],
  ['coherence63', (m) => m.aniso.coherence63],
  ['r63', (m) => m.aniso.r63],
  ['hetSlope', (m) => m.heterogeneity.slope],
  ['clearShare', (m) => m.heterogeneity.clearShare],
  ['areaP50', (m) => m.shapes.areaP50],
  ['boxDim', (m) => m.scaly.boxDim],
  ['clumpDiamP50', (m) => m.scaly.clumpDiamP50],
  ['midPowerRatio', (m) => m.scaly.midPowerRatio],
  ['gradientStrength', (m) => m.scaly.gradient === null ? null : m.scaly.gradient.strength],
  // 芯が無い窓は -1 — 欠測だと中央値補完で芯のある窓に似せてしまうため。
  ['assocNear', (m) => (m.assoc === null ? -1 : m.assoc.bins[0].maskShare)],
];

// 区分ごとの特徴量の分布。{ dims: {name: {p10,p50,p90,n}} }。
export function featureQuantiles(records) {
  const byClass = {};
  for (const record of records) {
    if (byClass[record.className] === undefined) byClass[record.className] = [];
    byClass[record.className].push(record.measured);
  }
  const out = {};
  for (const [className, list] of Object.entries(byClass)) {
    const dims = {};
    for (const [name, get] of FEATURE_DIMS) {
      const values = list.map(get).filter((v) => v !== null && Number.isFinite(v));
      if (values.length > 0) dims[name] = { ...distribution(values), n: values.length };
    }
    out[className] = { n: list.length, dims };
  }
  return out;
}

// 最近中心・leave-one-out の混同行列。z スコアは全標本の散らばり、欠損は区分の中央値で埋め、
// 欠損が 3 割を超える次元は外す。
export function looConfusion(records) {
  const classes = [...new Set(records.map((r) => r.className))].sort();
  const vectors = records.map((r) => FEATURE_DIMS.map(([, get]) => get(r.measured)));
  const usedDims = FEATURE_DIMS
    .map(([name], i) => ({ name, i, missing: vectors.filter((v) => v[i] === null || !Number.isFinite(v[i])).length }))
    .filter((d) => d.missing <= 0.3 * records.length);
  if (usedDims.length === 0 || classes.length < 2) {
    return { classes, matrix: [], accuracy: null, featuresUsed: [], method: 'nearest-centroid-loo' };
  }
  const dimStats = usedDims.map(({ i }) => {
    const observed = vectors.map((v) => v[i]).filter((v) => v !== null && Number.isFinite(v));
    const mean = observed.reduce((s, v) => s + v, 0) / observed.length;
    const std = Math.sqrt(observed.reduce((s, v) => s + (v - mean) ** 2, 0) / observed.length) || 1;
    return { mean, std, globalMedian: quantileOfSorted([...observed].sort((a, b) => a - b), 0.5) };
  });
  const normalized = records.map((record, ri) => usedDims.map(({ i }, di) => {
    let v = vectors[ri][i];
    if (v === null || !Number.isFinite(v)) {
      const same = records
        .map((r, j) => (r.className === record.className ? vectors[j][i] : null))
        .filter((x) => x !== null && Number.isFinite(x));
      v = same.length > 0 ? quantileOfSorted([...same].sort((a, b) => a - b), 0.5) : dimStats[di].globalMedian;
    }
    return (v - dimStats[di].mean) / dimStats[di].std;
  }));
  const matrix = classes.map(() => classes.map(() => 0));
  let correct = 0;
  for (let i = 0; i < records.length; i++) {
    let best = null;
    for (const className of classes) {
      const others = normalized.filter((_, j) => j !== i && records[j].className === className);
      if (others.length === 0) continue;
      const centroid = usedDims.map((_, di) => others.reduce((s, v) => s + v[di], 0) / others.length);
      const d = Math.sqrt(usedDims.reduce((s, _, di) => s + (normalized[i][di] - centroid[di]) ** 2, 0));
      if (best === null || d < best.d) best = { className, d };
    }
    const predicted = best === null ? null : best.className;
    matrix[classes.indexOf(records[i].className)][classes.indexOf(predicted)]++;
    if (predicted === records[i].className) correct++;
  }
  return {
    classes,
    matrix,
    accuracy: records.length > 0 ? correct / records.length : null,
    featuresUsed: usedDims.map((d) => d.name),
    method: 'nearest-centroid-loo(z-score, class-median impute)',
  };
}

// 層の PNG から値の場へ(decodeLayer の薄い包み)。
async function fieldOf(layerName, bytes) {
  const decoded = await decodeLayer(layerName, bytes);
  return decoded.field;
}

// manifest とキャッシュの窓から report.json と接触シートを組む。
export async function buildReport() {
  const config = loadLoopConfig();
  if (!existsSync(manifestFile)) throw new Error('manifest.json が無い — 先に teacher を回す');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const accepted = (manifest.candidates ?? []).filter((c) => c.status === 'ok');
  const records = [];
  const thumbsByClass = {};
  for (const point of accepted) {
    const files = point.files?.tier1;
    if (files === undefined) continue;
    const read = (name) => readFileSync(path.join(OUT_DIR, 'cache', name));
    const luminance = linearLuminanceField(read(files.truecolor));
    const cot = await fieldOf(files.cotLayer, read(files.cot));
    const cth = await fieldOf(files.cthLayer, read(files.cth));
    const mask = new Uint8Array(luminance.width * luminance.height);
    const cotValues = [];
    for (let i = 0; i < mask.length; i++) {
      const c = cot.data[i];
      const h = cth.data[i];
      if (Number.isFinite(c) && Number.isFinite(h)
        && h > TRANSLUCENT_CTH_MIN_M && c >= TRANSLUCENT_COT_RANGE[0] && c < TRANSLUCENT_COT_RANGE[1]) {
        mask[i] = 1;
        cotValues.push(c);
      }
    }
    let coreMask = null;
    if (files.coreMask !== undefined) {
      const decoded = decodeChannelPng(read(files.coreMask), 0);
      coreMask = Uint8Array.from(decoded.data, (v) => (v > 0.5 ? 1 : 0));
    }
    const measured = measureTranslucentWindow(luminance, {
      kmPerPx: 1,
      mask,
      cot,
      cth,
      coreMask,
      windDeg: point.wind?.deg ?? null,
      assocRadiusKm: point.className === 'anvil-active' ? 60 : null,
    });
    measured.cotP50 = cotValues.length > 0
      ? quantileOfSorted([...cotValues].sort((a, b) => a - b), 0.5)
      : null;
    records.push({ className: point.className, point, measured });
    // 接触シート用の 128² のサムネイル(1 km 真色の中央)。
    const rgb = decodePng(read(files.truecolor));
    const tx0 = Math.floor((rgb.width - 128) / 2);
    const ty0 = Math.floor((rgb.height - 128) / 2);
    const thumb = new Uint8Array(128 * 128 * 3);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        const from = ((ty0 + y) * rgb.width + tx0 + x) * rgb.channels;
        const to = (y * 128 + x) * 3;
        thumb[to] = rgb.data[from];
        thumb[to + 1] = rgb.data[from + 1];
        thumb[to + 2] = rgb.data[from + 2];
      }
    }
    if (thumbsByClass[point.className] === undefined) thumbsByClass[point.className] = [];
    thumbsByClass[point.className].push({ label: `#${point.slot}`, rgb: thumb });
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const className of Object.keys(thumbsByClass)) {
    writeFileSync(path.join(OUT_DIR, `sheet-${className}.png`),
      buildContactSheet(className, thumbsByClass[className]));
  }

  // scaly の判定要素を区分ごとに並べる。
  const scalyTable = {};
  for (const className of new Set(records.map((r) => r.className))) {
    const recs = records.filter((r) => r.className === className);
    const list = recs.map((r) => r.measured);
    const pick = (get) => {
      const values = list.map(get).filter((v) => v !== null && Number.isFinite(v));
      return values.length > 0 ? distribution(values) : null;
    };
    const windowKm = recs.map((r) => r.point.window?.sizeKm ?? 512).filter(Number.isFinite);
    scalyTable[className] = {
      n: list.length,
      windowKm: windowKm.length > 0 ? distribution(windowKm) : null,
      midPowerRatio: pick((m) => m.scaly.midPowerRatio),
      boxDim: pick((m) => m.scaly.boxDim),
      clumpCount: pick((m) => m.scaly.clumpCount),
      clumpDiamP50: pick((m) => m.scaly.clumpDiamP50),
      clumpDiamP90: pick((m) => m.scaly.clumpDiamP90),
      gapShare: pick((m) => m.scaly.gapShare),
      gradRSize: pick((m) => m.scaly.gradient?.rSize ?? null),
      gradRInt: pick((m) => m.scaly.gradient?.rInt ?? null),
      clearBlockShare: pick((m) => m.scaly.clearBlockShare),
      clusterAniso20: pick((m) => m.scaly.clusterAniso.s20 ?? null),
      clusterAniso63: pick((m) => m.scaly.clusterAniso.s63 ?? null),
      gradientStrength: pick((m) => m.scaly.gradient === null ? null : m.scaly.gradient.strength),
      gapIntensity: pick((m) => m.scaly.gapIntensity),
      edgeSharpness: pick((m) => m.scaly.edgeSharpness),
    };
  }

  const samples = {};
  for (const className of CLASSES) {
    const ok = accepted.filter((c) => c.className === className).length;
    const rejected = (manifest.candidates ?? []).filter((c) => c.className === className && c.status === 'rejected');
    const reasons = {};
    for (const r of rejected) reasons[r.rejectReason ?? 'unknown'] = (reasons[r.rejectReason ?? 'unknown'] ?? 0) + 1;
    samples[className] = { target: config.points, accepted: ok, rejected: rejected.length, rejectReasons: reasons };
  }

  let layers = null;
  const probeReport = path.join(OUT_DIR, 'probe', 'report.json');
  if (existsSync(probeReport)) layers = JSON.parse(readFileSync(probeReport, 'utf8')).layers ?? null;

  const report = {
    tool: 'cloud-translucent-teacher',
    generatedAt: new Date().toISOString(),
    seed: manifest.seed ?? config.seed,
    criteria: CLASSIFY,
    layers,
    samples,
    features: featureQuantiles(records),
    confusion: looConfusion(records),
    scalyStructure: scalyTable,
    decayCumulus: manifest.decayCumulus ?? null,
    coverageNotes: manifest.coverageNotes ?? null,
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${reportFile}(${records.length} 点)`);
  return report;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildReport().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
