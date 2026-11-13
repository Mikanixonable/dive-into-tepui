// 雲の細部の比較ループ。render-lab の本番ビルドをヘッドレス Chrome で開き、
// window.renderLab.cloudDetailShots() の全撮影(6 海域 × 3 時刻 × 3 段の km/px ×
// 積雲だけ/巻雲だけ/両方 = 162 枚)を shootCloudDetail() で 1 枚ずつ .cloud-detail/shots/ へ
// 撮る(既にあるものは飛ばす)。各撮影と .cloud-detail/reference/ の実写へ
// cloud-detail-metrics の物差しを当て、同じ種類(積雲主体/巻雲主体)の実写場面の測定値の
// 幅(封筒 = 最小〜最大 + 幅の 10%)からの距離を、特徴量の家族ごとに正規化して出し、
// 家族の平均を index とする。混合場面の実写はどちらの封筒にも入れず、撮影の比較相手
// (両方撮影の封筒と並べる画像)として使う。
// 最新の .cloud-lab/history/ の全球・cap スペクトルと繋いで 0.5〜1024 km の尺度の梯子を
// 1 表にし、実写と撮影を同じ km/px で左右に並べた画像を .cloud-detail/compare/ へ書き、
// レポートを .cloud-detail/history/ へ残して前回との差分を出す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { measureCloudDetail } from './cloud-detail-metrics.mjs';
import {
  collectNumericDiffs, formatDiffValue, gitHead, previousReportName, readReport, saveReport,
} from './cloud-report-history.mjs';
import { cropField } from './gray-image.mjs';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const renderLabDir = path.join(root, '.render-lab');
const detailDir = path.join(root, '.cloud-detail');
const shotsDir = path.join(detailDir, 'shots');
const compareDir = path.join(detailDir, 'compare');
const historyDir = path.join(detailDir, 'history');
const referenceManifestFile = path.join(detailDir, 'reference', 'manifest.json');
const scenesFile = path.join(import.meta.dirname, 'cloud-detail', 'scenes.json');
const port = 8772;
const debugPort = 9449;

// measureCloudDetail と同じ、計測に使う中央切り出しの一辺の上限 [px]。
const MAX_CROP_PX = 512;
// 封筒の余白。同じ種類の場面の最小〜最大へ、その幅のこの割合を両端へ足す。
const ENVELOPE_PAD = 0.1;
// 場面どうしのばらつきの判定下限(達成目標: 実写の場面どうしのばらつきのこの比以上)。
const VARIETY_FLOOR = 0.5;
// 局所コントラストを取る窓の一辺 [km]。画素へ直すとき下限 2 px を置く。
const CONTRAST_WINDOW_KM = 4;
// 距離の正規化の分母の下限。封筒の幅が 0 のとき、外れた量そのものを返す。
const MIN_ENVELOPE_WIDTH = 1e-6;
// 距離の前後判定の横ばいの幅(相対)。計測は決定的だが、実行環境の浮動小数の揺れを
// 悪化と誤判定しないための幅。
const VERDICT_BAND = 0.05;

// 特徴量の定義。id の接頭語 → 家族・値の集め方・正規化前の領域。
// scope 'band' は尺度の帯(オクターブ番号 j、帯 [2^j, 2^(j+1)] km)ごと、'scale' は
// 構造テン索ルの名目的な尺度 [km] ごと、'tier' は段の km/px ごとに封筒を組む。
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
  b: { family: 'shapes', scope: 'tier', domain: 'linear' },
  D: { family: 'shapes', scope: 'tier', domain: 'linear' },
  cloudyShare: { family: 'shapes', scope: 'tier', domain: 'linear' },
  cloudCount: { family: 'shapes', scope: 'tier', domain: 'log' },
  toneMean: { family: 'tone', scope: 'tier', domain: 'linear' },
  toneP50: { family: 'tone', scope: 'tier', domain: 'linear' },
  toneP90: { family: 'tone', scope: 'tier', domain: 'linear' },
  toneP99: { family: 'tone', scope: 'tier', domain: 'linear' },
};

// 特徴量の家族。index はこの平均。
const FAMILIES = ['spectrum', 'intermittency', 'periodicity', 'shapes', 'anisotropy', 'variety', 'tone'];

// 尺度の梯子に並べる帯(オクターブ番号 j = 帯 [2^j, 2^(j+1)] km)。0.5 km から 1024 km まで。
const LADDER_BANDS = [];
for (let j = -1; j <= 9; j++) LADDER_BANDS.push(j);

// sRGB の 1 チャンネル(0..255)を線形輝度(0..1)へ戻す。
function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// PNG を線形輝度の場へ。Rec.601 ではなく Rec.709 の輝度係数 — 実写の真色画像の
// モニタ輝度として読むため(cloud-detail-selftest と同じ定義)。
function linearLuminanceField(png) {
  const { width, height, channels, data } = decodePng(png);
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (channels === 1) {
      out[i] = srgbToLinear(data[i]);
    } else {
      const r = srgbToLinear(data[i * channels]);
      const g = srgbToLinear(data[i * channels + 1]);
      const b = srgbToLinear(data[i * channels + 2]);
      out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return { width, height, data: out };
}

// 計測と階調で共有する、中央からの切り出し(measureCloudDetail と同じ一辺)。
function centerCrop(field) {
  const limit = Math.min(MAX_CROP_PX, field.width, field.height);
  const n = 1 << Math.floor(Math.log2(limit));
  return cropField(field, Math.floor((field.width - n) / 2), Math.floor((field.height - n) / 2), n, n);
}

// 線形輝度の場の階調。平均と分位。
function toneStats(data) {
  const sorted = Float64Array.from(data).sort();
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  let sum = 0;
  for (const v of data) sum += v;
  return { mean: sum / data.length, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}

// 一辺 CONTRAST_WINDOW_KM の窓の標準偏差の全画素平均。窓は px へ直す(下限 2 px 分の半径)。
// 場面どうしのばらつき(variety)のもとになる局所統計。
function localContrast(field, kmPerPx) {
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

// 1 画像の測定値から、封筒・距離に使う特徴量の一覧を組む。
// 各要素は { id, family, scope, key, value } — id は接頭語@帯・尺度。value は
// domain 'log' のものを log10 へ写した後の値。null・非正の log は載せない。
function featureEntries(measured, tone) {
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
  add('toneMean', null, tone.mean);
  add('toneP50', null, tone.p50);
  add('toneP90', null, tone.p90);
  add('toneP99', null, tone.p99);
  return entries;
}

// 封筒の器。band/scale/tier の scope ごとに id → { min, max, samples }。
function newEnvelope() {
  return { band: new Map(), tier: new Map() };
}

// 特徴量 1 つを封筒の器へ足す。tier scope は段の km/px ごとの小さい器へ。
function envelopeAdd(envelope, entry, tierKmPerPx) {
  let bucket;
  if (entry.scope === 'tier') {
    const key = String(tierKmPerPx);
    if (!envelope.tier.has(key)) envelope.tier.set(key, new Map());
    bucket = envelope.tier.get(key);
  } else {
    bucket = envelope.band;
  }
  const cell = bucket.get(entry.id) ?? { min: Infinity, max: -Infinity, samples: 0 };
  cell.min = Math.min(cell.min, entry.value);
  cell.max = Math.max(cell.max, entry.value);
  cell.samples++;
  bucket.set(entry.id, cell);
}

// 集めた最小〜最大へ幅の ENVELOPE_PAD 倍の余白を足した判定幅 { lo, hi } を返す。
function paddedCell(cell) {
  const width = cell.max - cell.min;
  return { lo: cell.min - width * ENVELOPE_PAD, hi: cell.max + width * ENVELOPE_PAD };
}

// 封筒の器から id に対応する判定幅を引く。scope 'tier' は段の km/px が一致する器から。
// 無いもの、標本が 1 つ(幅の定義がない)、実写の値が全部一致して幅が 0 のものは null —
// 幅のない封筒では「どれだけ外れているか」を正規化できないので、その特徴量は比較しない。
function envelopeCell(envelope, entry, tierKmPerPx) {
  const bucket = entry.scope === 'tier' ? envelope.tier.get(String(tierKmPerPx)) : envelope.band;
  const cell = bucket?.get(entry.id);
  if (cell === undefined || cell.samples < 2 || !(cell.max > cell.min)) return null;
  return paddedCell(cell);
}

// 2 種類の封筒の和集合(both 撮影の混合場面用)。各 scope の器を id ごとに併合し、
// 余白は併合後の幅から取り直す。
function mergedEnvelope(a, b) {
  const merged = newEnvelope();
  const mergeInto = (target, left, right) => {
    const ids = new Set([...left.keys(), ...right.keys()]);
    for (const id of ids) {
      const x = left.get(id);
      const y = right.get(id);
      target.set(id, {
        min: Math.min(x?.min ?? Infinity, y?.min ?? Infinity),
        max: Math.max(x?.max ?? -Infinity, y?.max ?? -Infinity),
        samples: (x?.samples ?? 0) + (y?.samples ?? 0),
      });
    }
  };
  mergeInto(merged.band, a.band, b.band);
  const tierKeys = new Set([...a.tier.keys(), ...b.tier.keys()]);
  for (const key of tierKeys) {
    const tier = new Map();
    mergeInto(tier, a.tier.get(key) ?? new Map(), b.tier.get(key) ?? new Map());
    merged.tier.set(key, tier);
  }
  return merged;
}

// 値 v の判定幅 cell からの正規化距離。中なら 0、外なら外れた量を幅で割った値。
// side は -1(下回る)/0(内)/+1(超える)。
function distanceOf(value, cell) {
  const width = Math.max(cell.hi - cell.lo, MIN_ENVELOPE_WIDTH);
  if (value < cell.lo) return { distance: (cell.lo - value) / width, side: -1 };
  if (value > cell.hi) return { distance: (value - cell.hi) / width, side: +1 };
  return { distance: 0, side: 0 };
}

// 中央切り出しの RGB(A) 画像 2 枚を、小さい方の辺に合わせて左右に並べた RGB 画素列を返す。
function sideBySideRgb(left, right) {
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  const cropOf = (img) => ({
    x0: Math.floor((img.width - width) / 2),
    y0: Math.floor((img.height - height) / 2),
    channels: img.channels,
    data: img.data,
    stride: img.width * img.channels,
  });
  const a = cropOf(left);
  const b = cropOf(right);
  const out = new Uint8Array(width * 2 * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width * 2 + x) * 3;
      const sa = (y + a.y0) * a.stride + (x + a.x0) * a.channels;
      const sb = (y + b.y0) * b.stride + (x + b.x0) * b.channels;
      out[dst] = left.data[sa];
      out[dst + 1] = left.data[sa + 1];
      out[dst + 2] = left.data[sa + 2];
      const dstR = (y * width * 2 + width + x) * 3;
      out[dstR] = right.data[sb];
      out[dstR + 1] = right.data[sb + 1];
      out[dstR + 2] = right.data[sb + 2];
    }
  }
  return { width: width * 2, height, data: out };
}

// 値の列の分散(不偏)。1 個では 0。
function variance(values) {
  if (values.length < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let sum = 0;
  for (const v of values) sum += (v - mean) * (v - mean);
  return sum / (values.length - 1);
}

// 値の列の中央値。空では null。
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

async function shootMissing(shotInfos) {
  const missing = shotInfos.filter((info) => !existsSync(path.join(shotsDir, `${info.name}.png`)));
  if (missing.length === 0) return 0;
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'tepui-cloud-detail-', onEvent,
    requestTimeoutMs: 120_000,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootCloudDetail === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    let taken = 0;
    for (const info of missing) {
      const dataUrl = await devTools.evaluate(`window.renderLab.shootCloudDetail(${JSON.stringify(info.name)})`);
      writeFileSync(
        path.join(shotsDir, `${info.name}.png`),
        Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
      );
      taken++;
      if (taken % 10 === 0 || taken === missing.length) console.log(`shot ${taken}/${missing.length} ${info.name}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    return taken;
  } finally {
    await session.close();
  }
}

async function main() {
  if (!existsSync(referenceManifestFile)) {
    throw new Error(`${referenceManifestFile} が無い — 先に npm run cloud-detail:reference を実行する`);
  }
  const scenes = JSON.parse(readFileSync(scenesFile, 'utf8'));
  const sceneKind = new Map(scenes.map((scene) => [scene.name, scene.kind]));
  const referenceManifest = JSON.parse(readFileSync(referenceManifestFile, 'utf8'));

  // --- 撮影: 一覧をページから引き、足りない分だけ撮って manifest を書き直す ---
  mkdirSync(shotsDir, { recursive: true });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'tepui-cloud-detail-', onEvent,
    requestTimeoutMs: 120_000,
  });
  let shotInfos;
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.cloudDetailShots === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    shotInfos = await devTools.evaluate('window.renderLab.cloudDetailShots()');
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
  } finally {
    await session.close();
  }
  const taken = await shootMissing(shotInfos);
  console.log(`撮影: 全 ${shotInfos.length} 枚のうち ${taken} 枚を新たに撮った(既存は飛ばす)`);
  writeFileSync(path.join(shotsDir, 'manifest.json'), `${JSON.stringify({
    tool: 'cloud-detail-compare',
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(root),
    shots: shotInfos,
  }, null, 2)}\n`);

  // --- 計測: 各撮影と各実写へ同じ物差しを当てる ---
  const measureImage = (png, kmPerPx) => {
    const field = linearLuminanceField(png);
    const crop = centerCrop(field);
    const tone = toneStats(crop.data);
    const contrast = localContrast(crop, kmPerPx);
    const measured = measureCloudDetail(field, kmPerPx);
    return {
      measured, tone, contrast,
      cropSize: measured.cropSize,
      features: featureEntries(measured, tone),
    };
  };

  const references = [];
  for (const scene of referenceManifest.scenes) {
    for (const tier of scene.tiers) {
      const file = path.join(root, tier.file);
      const image = {
        id: `${scene.name}-${tier.kmPerPx}`,
        scene: scene.name,
        kind: scene.kind,
        kmPerPx: tier.kmPerPx,
        file: tier.file,
        ...measureImage(readFileSync(file), tier.kmPerPx),
      };
      delete image.measured;
      references.push(image);
    }
  }
  console.log(`実写 ${references.length} 枚を計測した`);

  const shots = new Map();
  let shotIndex = 0;
  for (const info of shotInfos) {
    const png = readFileSync(path.join(shotsDir, `${info.name}.png`));
    shots.set(info.name, {
      ...info,
      sceneKind: sceneKind.get(info.scene) ?? 'mixed',
      ...measureImage(png, info.centerKmPerPx),
    });
    shotIndex++;
    if (shotIndex % 20 === 0) console.log(`shot 計測 ${shotIndex}/${shotInfos.length}`);
  }
  console.log(`撮影 ${shots.size} 枚を計測した`);

  // --- 封筒: 同じ種類の場面の最小〜最大 + 幅の 10%。混合場面はどちらにも入れない ---
  const envelopes = { cumulus: newEnvelope(), cirrus: newEnvelope() };
  for (const image of references) {
    if (image.kind !== 'cumulus' && image.kind !== 'cirrus') continue;
    for (const entry of image.features) envelopeAdd(envelopes[image.kind], entry, image.kmPerPx);
  }
  envelopes.union = mergedEnvelope(envelopes.cumulus, envelopes.cirrus);

  // 撮影がどの封筒で判定されるか。cumulus/cirrus 撮影はその種類の封筒、
  // both 撮影は場面の種類の封筒(混合場面では 2 種類の和集合)。
  const envelopeOfShot = (shot) => {
    if (shot.kind === 'cumulus') return 'cumulus';
    if (shot.kind === 'cirrus') return 'cirrus';
    return shot.sceneKind === 'mixed' ? 'union' : shot.sceneKind;
  };

  // --- 距離: 特徴量ごとの正規化距離を家族ごとに集める ---
  const familySum = new Map();
  const kindFamilySum = new Map();
  const accumulate = (family, distance, kind) => {
    for (const table of [familySum, kindFamilySum.get(kind)]) {
      const cell = table.get(family) ?? { sum: 0, count: 0 };
      cell.sum += distance;
      cell.count++;
      table.set(family, cell);
    }
  };
  for (const kind of ['cumulus', 'cirrus', 'both']) {
    kindFamilySum.set(kind, new Map());
  }
  for (const shot of shots.values()) {
    const envelopeKey = envelopeOfShot(shot);
    const envelope = envelopes[envelopeKey];
    shot.envelope = envelopeKey;
    shot.distances = {};
    for (const entry of shot.features) {
      const cell = envelopeCell(envelope, entry, shot.tierKmPerPx);
      if (cell === null) continue;
      const { distance } = distanceOf(entry.value, cell);
      shot.distances[entry.id] = distance;
      accumulate(entry.family, distance, shot.kind);
    }
  }

  // --- variety: 場面どうしの局所統計(局所コントラスト)のばらつきの比 ---
  // 実写はその種類の場面だけ(both は全場面)、撮影は全 6 海域(時刻は平均)。
  const variety = {};
  for (const [shotKind, referenceKinds] of [
    ['cumulus', ['cumulus']], ['cirrus', ['cirrus']], ['both', ['cumulus', 'cirrus', 'mixed']],
  ]) {
    const byTier = {};
    for (const tier of [0.25, 1, 4]) {
      const referenceValues = references
        .filter((image) => referenceKinds.includes(image.kind) && image.kmPerPx === tier)
        .map((image) => image.contrast);
      const sceneMeans = new Map();
      for (const shot of shots.values()) {
        if (shot.kind !== shotKind || shot.tierKmPerPx !== tier) continue;
        const list = sceneMeans.get(shot.scene) ?? [];
        list.push(shot.contrast);
        sceneMeans.set(shot.scene, list);
      }
      const shotValues = [...sceneMeans.values()].map(
        (list) => list.reduce((sum, v) => sum + v, 0) / list.length,
      );
      if (referenceValues.length < 2 || shotValues.length < 2) continue;
      const shotVariance = variance(shotValues);
      const referenceVariance = variance(referenceValues);
      const ratio = referenceVariance > 0 ? shotVariance / referenceVariance : (shotVariance > 0 ? Infinity : 1);
      const distance = Math.max(0, VARIETY_FLOOR - ratio) / VARIETY_FLOOR;
      byTier[tier] = { referenceVariance, shotVariance, ratio, distance, shots: shotValues.length, references: referenceValues.length };
      accumulate('variety', distance, shotKind);
    }
    variety[shotKind] = byTier;
  }

  // --- 家族ごとの距離と index ---
  const families = {};
  for (const family of FAMILIES) {
    const cell = familySum.get(family);
    if (cell !== undefined && cell.count > 0) families[family] = cell.sum / cell.count;
  }
  const index = Object.values(families).reduce((sum, v) => sum + v, 0) / Math.max(1, Object.keys(families).length);
  const distances = { families, index };

  console.log('\n=== 実写との距離(特徴量の家族ごと、0 が一致) ===');
  console.log(`${'family'.padEnd(15)} 全部    積雲撮影  巻雲撮影  両方撮影`);
  for (const family of FAMILIES) {
    const cell = familySum.get(family);
    const columns = ['cumulus', 'cirrus', 'both'].map((kind) => {
      const kindCell = kindFamilySum.get(kind).get(family);
      return kindCell === undefined ? '  -   ' : (kindCell.sum / kindCell.count).toFixed(3).padStart(6);
    });
    console.log(`${family.padEnd(15)} ${cell === undefined ? '  -   ' : (cell.sum / cell.count).toFixed(3).padStart(6)} ${columns.join('  ')}`);
  }
  console.log(`${'index (家族の平均)'.padEnd(15)} ${index.toFixed(3)}`);

  // --- 封筒から外れた特徴量の一覧(正規化距離の大きい順) ---
  console.log('\n=== 封筒から外れた特徴量(正規化距離の上位) ===');
  const offenders = [];
  for (const shot of shots.values()) {
    for (const [id, distance] of Object.entries(shot.distances)) {
      if (distance > 0) offenders.push({ shot: shot.name, id, distance });
    }
  }
  offenders.sort((a, b) => b.distance - a.distance);
  for (const offender of offenders.slice(0, 25)) {
    console.log(`${offender.distance.toFixed(2).padStart(7)}  ${offender.shot}  ${offender.id}`);
  }
  console.log(`封筒外の特徴量: ${offenders.length}(判定した全特徴量は撮影 ${shots.size} 枚ぶん)`);

  // --- 周期性(積雲の撮影のピーク尺度と超過比) ---
  console.log('\n=== 周期性(冪乗則からの超過比とピーク尺度) ===');
  for (const kind of ['cumulus', 'cirrus']) {
    const peaks = new Map();
    const excesses = [];
    for (const shot of shots.values()) {
      if (shot.kind !== kind) continue;
      const peak = shot.measured.periodicity.peakScaleKm;
      if (peak !== null) {
        const bin = Math.floor(Math.log2(peak));
        peaks.set(bin, (peaks.get(bin) ?? 0) + 1);
      }
      if (shot.measured.periodicity.maxExcessRatio !== null) excesses.push(shot.measured.periodicity.maxExcessRatio);
    }
    const tierCells = [...envelopes[kind].tier.entries()]
      .map(([tier, bucket]) => {
        const cell = bucket.get('excess');
        if (cell === undefined) return `${tier}km: n/a`;
        const { lo, hi } = paddedCell(cell);
        return `${tier}km: [${formatDiffValue(10 ** lo)}, ${formatDiffValue(10 ** hi)}]`;
      })
      .join('  ');
    const peakText = [...peaks.entries()].sort((a, b) => a[0] - b[0])
      .map(([bin, count]) => `${2 ** bin}-${2 ** (bin + 1)} km×${count}`).join('  ');
    const excessMedian = median(excesses);
    console.log(`${kind}: 超過比 中央値 ${excessMedian === null ? 'n/a' : formatDiffValue(excessMedian)}  封筒 ${tierCells}`);
    console.log(`       ピーク尺度の分布: ${peakText}`);
  }

  // --- 巻雲のオクターブ・パワー(帯ごとの封筒との関係) ---
  console.log('\n=== 巻雲の帯ごとのパワー(封筒の log10 幅と撮影の位置) ===');
  console.log('帯 [km]     封筒(log10)        撮影 下回る/内/超える');
  for (const band of LADDER_BANDS) {
    const id = `power@${band}`;
    const cell = envelopes.cirrus.band.get(id);
    if (cell === undefined) continue;
    const { lo, hi } = paddedCell(cell);
    let below = 0;
    let inside = 0;
    let above = 0;
    for (const shot of shots.values()) {
      if (shot.kind !== 'cirrus') continue;
      const entry = shot.features.find((feature) => feature.id === id);
      if (entry === undefined) continue;
      const { side } = distanceOf(entry.value, { lo, hi });
      if (side < 0) below++;
      else if (side > 0) above++;
      else inside++;
    }
    if (below + inside + above === 0) continue;
    console.log(`${`${2 ** band}-${2 ** (band + 1)}`.padStart(10)}  [${lo.toFixed(2)}, ${hi.toFixed(2)}]  ${below}/${inside}/${above}`);
  }

  // --- 実写の文献検算: 場面・段ごとの b と D が文献の幅に入るか ---
  // 幅は文献のプール値(b = 1.66 ± 0.3、D = 1.35 ± 0.1)。単場面・単段の fit をこの幅で
  // 判定するのが適切かは計画の未解決の判断 — ここでは事実だけを表に出す。
  console.log('\n=== 実写の文献検算(b = 1.66 ± 0.3、D = 1.35 ± 0.1) ===');
  let bInside = 0;
  let dInside = 0;
  let bTotal = 0;
  let dTotal = 0;
  for (const image of references) {
    const b = image.features.find((feature) => feature.id === 'b')?.value;
    const d = image.features.find((feature) => feature.id === 'D')?.value;
    const bIn = b !== undefined && Math.abs(b - 1.66) <= 0.3;
    const dIn = d !== undefined && Math.abs(d - 1.35) <= 0.1;
    if (b !== undefined) { bTotal++; if (bIn) bInside++; }
    if (d !== undefined) { dTotal++; if (dIn) dInside++; }
    console.log(`${image.id.padEnd(38)} b ${b === undefined ? '   n/a' : b.toFixed(2).padStart(6)}${b === undefined ? '    ' : (bIn ? ' 内' : ' 外')}  D ${d === undefined ? '   n/a' : d.toFixed(2).padStart(6)}${d === undefined ? '    ' : (dIn ? ' 内' : ' 外')}`);
  }
  console.log(`幅内: b ${bInside}/${bTotal}、D ${dInside}/${dTotal}`);

  // --- 尺度の梯子: 0.5〜1024 km の帯ごとの生成/実写のパワー比 ---
  // 細かい側はこの道具のオクターブ・パワー(log10 の中央値の差)、粗い側は最新の
  // .cloud-lab/history/ の capSpectrum(被覆率/実写厚)と spectrumGlobe(同)の帯の比。
  console.log('\n=== 尺度の梯子(帯ごとの 生成/実写 のパワー比) ===');
  const labHistoryDir = path.join(root, '.cloud-lab', 'history');
  const labPreviousName = previousReportName(labHistoryDir);
  const labReport = labPreviousName === undefined ? null : readReport(labHistoryDir, labPreviousName);
  const capRatios = new Map(LADDER_BANDS.map((band) => [band, []]));
  const globeRatios = new Map(LADDER_BANDS.map((band) => [band, []]));
  if (labReport?.sections) {
    const collect = (entries, out) => {
      for (const entry of entries ?? []) {
        for (const bucket of entry.buckets) {
          const mid = Math.sqrt(bucket.wavelengthKm[0] * bucket.wavelengthKm[1]);
          const band = Math.floor(Math.log2(mid));
          if (out.has(band)) out.get(band).push(bucket.ratio);
        }
      }
    };
    collect(labReport.sections.capSpectrum, capRatios);
    collect(
      (labReport.sections.spectrumGlobe ?? []).filter((entry) => entry.reference === 'thick'),
      globeRatios,
    );
    console.log(`(.cloud-lab/history/${labPreviousName} の capSpectrum・spectrumGlobe を使う)`);
  } else {
    console.log('.cloud-lab/history/ にレポートが無い — cap・全球の列は空のまま');
  }
  const ladder = [];
  console.log('帯 [km]      積雲  巻雲  cap   全球');
  for (const band of LADDER_BANDS) {
    const id = `power@${band}`;
    const row = { bandKm: [2 ** band, 2 ** (band + 1)] };
    for (const [kind, key] of [['cumulus', 'cumulus'], ['cirrus', 'cirrus']]) {
      const generated = [];
      for (const shot of shots.values()) {
        if (shot.kind !== kind) continue;
        const entry = shot.features.find((feature) => feature.id === id);
        if (entry !== undefined) generated.push(entry.value);
      }
      const reference = references
        .filter((image) => image.kind === kind)
        .flatMap((image) => image.features.filter((feature) => feature.id === id).map((feature) => feature.value));
      row[key] = generated.length > 0 && reference.length > 0
        ? 10 ** (median(generated) - median(reference))
        : null;
    }
    row.cap = median(capRatios.get(band));
    row.globe = median(globeRatios.get(band));
    ladder.push(row);
    const cell = (value) => (value === null ? '   -  ' : value.toExponential(2).padStart(6));
    console.log(`${`${row.bandKm[0]}-${row.bandKm[1]}`.padStart(10)}  ${cell(row.cumulus)}  ${cell(row.cirrus)}  ${cell(row.cap)}  ${cell(row.globe)}`);
  }

  // --- 比較画像: 場面・段ごとに実写と撮影(両方・時刻 0)を同じ km/px で左右に並べる ---
  mkdirSync(compareDir, { recursive: true });
  let compareCount = 0;
  for (const image of references) {
    const shotInfo = shotInfos.find((info) => info.scene === image.scene
      && info.kind === 'both' && info.tierKmPerPx === image.kmPerPx && info.displayTime === 0);
    if (shotInfo === undefined) continue;
    const shotPng = decodePng(readFileSync(path.join(shotsDir, `${shotInfo.name}.png`)));
    const referencePng = decodePng(readFileSync(path.join(root, image.file)));
    const combined = sideBySideRgb(shotPng, referencePng);
    writeFileSync(
      path.join(compareDir, `${image.scene}-${image.kmPerPx}km.png`),
      encodeRgbPng(combined.width, combined.height, combined.data),
    );
    compareCount++;
  }
  console.log(`\n比較画像 ${compareCount} 枚を .cloud-detail/compare/ へ書いた(左=撮影・右=実写、同じ km/px)`);

  // --- レポート ---
  const featureTableOf = (image) => Object.fromEntries(image.features.map((entry) => [entry.id, entry.value]));
  const envelopeTableOf = (envelope) => {
    const out = { band: {}, tier: {} };
    for (const [id, cell] of envelope.band) {
      out.band[id] = { min: cell.min, max: cell.max, ...paddedCell(cell), samples: cell.samples };
    }
    for (const [tier, bucket] of envelope.tier) {
      out.tier[tier] = {};
      for (const [id, cell] of bucket) {
        out.tier[tier][id] = { min: cell.min, max: cell.max, ...paddedCell(cell), samples: cell.samples };
      }
    }
    return out;
  };
  const report = {
    meta: {
      tool: 'cloud-detail-compare',
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      gitHead: gitHead(root),
      shots: shots.size,
      references: references.length,
      labHistory: labPreviousName ?? null,
    },
    sections: {
      envelopes: Object.fromEntries(Object.entries(envelopes).map(([kind, envelope]) => [kind, envelopeTableOf(envelope)])),
      references: Object.fromEntries(references.map((image) => [image.id, {
        scene: image.scene, kind: image.kind, kmPerPx: image.kmPerPx, cropSize: image.cropSize,
        contrast: image.contrast, features: featureTableOf(image),
      }])),
      shots: Object.fromEntries([...shots.entries()].map(([name, shot]) => [name, {
        scene: shot.scene, sceneKind: shot.sceneKind, kind: shot.kind,
        tierKmPerPx: shot.tierKmPerPx, centerKmPerPx: shot.centerKmPerPx,
        displayTime: shot.displayTime, envelope: shot.envelope, cropSize: shot.cropSize,
        contrast: shot.contrast, features: featureTableOf(shot), distances: shot.distances,
      }])),
      variety,
      ladder,
    },
    distances,
  };

  const previousName = previousReportName(historyDir);
  saveReport(historyDir, report);
  console.log('\n=== 前回レポートとの差分 ===');
  if (previousName === undefined) {
    console.log('前回のレポートが無い(今回が初回)');
  } else {
    const previous = readReport(historyDir, previousName);
    if (previous === null || previous.sections === undefined) {
      console.log(`${previousName} が読めないため差分を出せない`);
    } else {
      const diffs = { compared: 0, changed: [] };
      collectNumericDiffs(previous.sections, report.sections, '', diffs);
      for (const { path: leaf, before, after } of diffs.changed) {
        const delta = after - before;
        console.log(`${leaf}: ${formatDiffValue(before)} → ${formatDiffValue(after)} (${delta >= 0 ? '+' : ''}${formatDiffValue(delta)})`);
      }
      console.log(diffs.changed.length === 0
        ? `変わった数値なし(比較した数値 ${diffs.compared}、前回: ${previousName})`
        : `変わった数値 ${diffs.changed.length} / ${diffs.compared}(前回: ${previousName})`);
    }

    // 距離の前後判定。相対 VERDICT_BAND 以内は横ばい — 撮り直し・計測の揺らぎの幅として出す。
    const priorDistances = previous?.distances;
    if (priorDistances?.families) {
      let improved = 0;
      let worsened = 0;
      let unchanged = 0;
      console.log(`\n=== 距離の変化(前回比、相対 ${VERDICT_BAND * 100}% 以内は横ばい) ===`);
      for (const [family, after] of Object.entries(report.distances.families)) {
        const priorValue = priorDistances.families[family];
        if (priorValue === undefined) {
          console.log(`${family.padEnd(15)} (前回は未計測) → ${after.toFixed(3)}`);
          continue;
        }
        const relative = priorValue > 0 ? (after - priorValue) / priorValue : (after > 0 ? Infinity : 0);
        const verdict = relative < -VERDICT_BAND ? '改善' : relative > VERDICT_BAND ? '悪化' : '横ばい';
        if (verdict === '改善') improved++;
        else if (verdict === '悪化') worsened++;
        else unchanged++;
        console.log(`${family.padEnd(15)} ${priorValue.toFixed(3)} → ${after.toFixed(3)}  ${verdict}`);
      }
      console.log(`改善 ${improved} / 悪化 ${worsened} / 横ばい ${unchanged}`
        + `(index: ${priorDistances.index.toFixed(3)} → ${report.distances.index.toFixed(3)})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
