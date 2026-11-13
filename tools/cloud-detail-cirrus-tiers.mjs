// 巻雲の精細さ「粗」と「標準」の撮影の、50 km 四方の箱ごとの平均輝度の比。細部が濃さの平均を
// 変えないことを確かめる。標準の撮影は cloud-detail:compare が撮った .cloud-detail/shots/ を使い、
// 粗の撮影(<標準の撮影名>-coarse)は足りないものだけ撮って .cloud-detail/cirrus-tiers/ へ書く。
// 比は箱ごとに「粗 / 標準」の線形輝度の平均で、中央 512 px(計測と同じ切り出し)を一辺 50 km の箱で
// 区切る。箱の全部が 1 ± TOLERANCE に入るかを段ごとに表に出す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';
import { cropField } from './gray-image.mjs';

const root = path.resolve(import.meta.dirname, '..');
const renderLabDir = path.join(root, '.render-lab');
const detailDir = path.join(root, '.cloud-detail');
const standardDir = path.join(detailDir, 'shots');
const coarseDir = path.join(detailDir, 'cirrus-tiers');
const port = 8773;
const debugPort = 9450;

// 箱の一辺 [km]。
const BOX_KM = 50;
// 中央から切り出す一辺の上限 [px](計測と同じ)。
const MAX_CROP_PX = 512;
// 箱ごとの比が 1 からこの幅の中に入るかの判定。
const TOLERANCE = 0.05;

// sRGB の 1 チャンネル(0..255)を線形輝度(0..1)へ戻す。
function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// PNG を線形輝度の場へ(Rec.709 の輝度係数。計測と同じ定義)。
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

// 中央の正方形(一辺は 512 以下の 2 の冪)を切り出す。
function centerCrop(field) {
  const limit = Math.min(MAX_CROP_PX, field.width, field.height);
  const n = 1 << Math.floor(Math.log2(limit));
  return cropField(field, Math.floor((field.width - n) / 2), Math.floor((field.height - n) / 2), n, n);
}

// 正方形の場を一辺 box 画素の箱へ区切り、箱ごとの平均を行優先で返す。端の余りは捨てる。
function boxMeans(field, box) {
  const count = Math.floor(field.width / box);
  const means = [];
  for (let by = 0; by < count; by++) {
    for (let bx = 0; bx < count; bx++) {
      let sum = 0;
      for (let y = by * box; y < (by + 1) * box; y++) {
        for (let x = bx * box; x < (bx + 1) * box; x++) sum += field.data[y * field.width + x];
      }
      means.push(sum / (box * box));
    }
  }
  return means;
}

// 撮影名の段(0.25 / 1 / 4 km/px)ごとに、比の要約を組む。
function summarize(ratios) {
  const sorted = [...ratios].sort((a, b) => a - b);
  const inside = ratios.filter((r) => Math.abs(r - 1) <= TOLERANCE).length;
  const maxDeviation = Math.max(...ratios.map((r) => Math.abs(r - 1)));
  return {
    boxes: ratios.length,
    min: sorted[0],
    median: sorted[sorted.length >> 1],
    max: sorted[sorted.length - 1],
    insideShare: inside / ratios.length,
    maxDeviation,
  };
}

// 粗の撮影のうち、まだ無いものを撮る。撮影名は標準の撮影名 + -coarse。
async function shootMissingCoarse(names) {
  const missing = names.filter((name) => !existsSync(path.join(coarseDir, `${name}.png`)));
  if (missing.length === 0) return 0;
  mkdirSync(coarseDir, { recursive: true });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: renderLabDir, port, debugPort, profilePrefix: 'tepui-cloud-tiers-', onEvent,
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
    for (const name of missing) {
      const dataUrl = await devTools.evaluate(`window.renderLab.shootCloudDetail(${JSON.stringify(name)})`);
      writeFileSync(
        path.join(coarseDir, `${name}.png`),
        Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'),
      );
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    return missing.length;
  } finally {
    await session.close();
  }
}

async function main() {
  const manifestFile = path.join(standardDir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`${manifestFile} が無い — 先に npm run cloud-detail:compare を実行する`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const cirrusShots = manifest.shots.filter((shot) => shot.kind === 'cirrus');
  const coarseNames = cirrusShots.map((shot) => `${shot.name}-coarse`);

  const taken = await shootMissingCoarse(coarseNames);
  console.log(`粗の撮影: ${coarseNames.length} 枚のうち ${taken} 枚を新たに撮った(既存は飛ばす)`);

  const byTier = new Map();
  for (const shot of cirrusShots) {
    const standardPath = path.join(standardDir, `${shot.name}.png`);
    const coarsePath = path.join(coarseDir, `${shot.name}-coarse.png`);
    if (!existsSync(standardPath) || !existsSync(coarsePath)) continue;
    const standard = centerCrop(linearLuminanceField(readFileSync(standardPath)));
    const coarse = centerCrop(linearLuminanceField(readFileSync(coarsePath)));
    const box = Math.max(1, Math.round(BOX_KM / shot.centerKmPerPx));
    const standardMeans = boxMeans(standard, box);
    const coarseMeans = boxMeans(coarse, box);
    const ratios = coarseMeans.map((value, index) => value / standardMeans[index]);
    const tier = shot.tierKmPerPx;
    const list = byTier.get(tier) ?? [];
    list.push({ name: shot.name, box, ratios });
    byTier.set(tier, list);
  }

  console.log(`\n=== 巻雲の精細さ 粗 / 標準 の箱ごとの平均輝度の比(箱 ${BOX_KM} km、許容 1 ± ${TOLERANCE}) ===`);
  console.log('段 [km/px]  撮影  箱数  最小    中央値  最大    範囲内  最大のずれ');
  const report = {};
  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    const list = byTier.get(tier);
    const ratios = list.flatMap((entry) => entry.ratios);
    const summary = summarize(ratios);
    report[tier] = { shots: list.length, ...summary };
    console.log(
      `${String(tier).padEnd(10)}  ${String(list.length).padStart(4)}  ${String(summary.boxes).padStart(4)}  `
      + `${summary.min.toFixed(3)}  ${summary.median.toFixed(3)}   ${summary.max.toFixed(3)}  `
      + `${(summary.insideShare * 100).toFixed(1).padStart(5)}%  ${summary.maxDeviation.toFixed(3)}`,
    );
  }
  mkdirSync(coarseDir, { recursive: true });
  writeFileSync(path.join(coarseDir, 'report.json'), `${JSON.stringify({
    tool: 'cloud-detail-cirrus-tiers', boxKm: BOX_KM, tolerance: TOLERANCE, tiers: report,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
