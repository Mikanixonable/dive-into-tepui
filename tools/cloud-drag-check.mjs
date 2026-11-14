// ドラッグ中の雲の検査。視点が毎フレーム動き、表示時刻も進むときの 1 フレームを、同じ視点を落ち着くまで
// 描いた絵と比べる。雲の読み手(不透明表面・雲影・大気)のどれかが、1 フレーム前の混ぜ方・cap の置き方・時刻で
// 描かれる不具合があると、cap を置き直したフレームの絵が落ち着いた絵からずれる。
//   連続: render-lab の captureAfterMove で、観察の向きと表示時刻を置いてから描画をちょうど 1 回回した絵。
//   静止: 同じ向き・時刻を置いたあと、連続する 2 回の撮影が一致するまで描き直した絵。
// 比べるのは、輝度から大きな尺度の傾きを除いた画像の相関(NCC)。同じ絵なら 1 で、1 フレーム遅れた雲場が
// 混ざると 0.9 台へ落ちる。すべての枠が NCC_MIN 以上なら合格。報告は .cloud-detail/drag/ へ、基準を割った枠の
// 連続・静止の PNG と一緒に残す。使い方: npm run cloud-detail:drag(render-lab の本番ビルドを組んでから走る)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-detail', 'drag');
const port = 8778;
const debugPort = 9457;

// 合格の下限。落ち着いた絵と同じ絵なら 1。ドラッグ中の遅れが入った絵は 0.91〜0.93 まで落ちた。
const NCC_MIN = 0.99;
// 大きな尺度の傾きを引く箱ぼかしの半幅 [画素]。
const HIGH_PASS_RADIUS = 12;
// 相関を取る画像中心の円の半径 [画素]。
const MASK_RADIUS = 250;
// 検査する動かし方。stepPx は視点を 1 フレームに動かす距離(画像の画素)、timeStepS は 1 フレームに進む
// 表示時刻 [s]。cap の置き直しは視点が動くたびに起き、焼いた 2 枚の補間は表示時刻の刻みごとに入れ替わるので、
// 置き直しと入れ替わりが重なる刻みと、毎フレーム焼き直す刻み(雲場を焼く刻み 6 s を超える)を取る。
const MOVES = [
  { name: 'drag-slow-time', stepPx: 20, timeStepS: 0.9 },
  { name: 'drag-fast-time', stepPx: 20, timeStepS: 7 },
];
// 場面の直下点と、段の目標 km/px。frames + 1 枚を連続で撮る。
const SITES = [
  { name: 'wpac', latitudeDeg: 35, longitudeDeg: 150 },
  { name: 'natl', latitudeDeg: 50, longitudeDeg: -30 },
];
const TIER_KM_PER_PX = 4;
const FRAMES = 12;
const START_DISPLAY_TIME_S = 21600;
// 雲の種類。both は積雲・巻雲・雲影、cirrus は積雲の細部をオフにして巻雲(大気)だけを見る。
const KINDS = [
  { name: 'both', options: [] },
  { name: 'cirrus', options: [['cumulusDetail', 0]] },
];
// 絵が落ち着くまで撮り直す上限。
const MAX_SETTLE_CAPTURES = 8;

function lumaOf(png) {
  const { width, height, channels, data } = decodePng(png);
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = 0.299 * data[i * channels] + 0.587 * data[i * channels + 1] + 0.114 * data[i * channels + 2];
  }
  return { width, height, luma };
}

// 画素から半幅 radius の箱ぼかしを引く。
function highPass({ width, height, luma }, radius) {
  const rowBlur = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const clampX = (x) => Math.min(width - 1, Math.max(0, x));
  const clampY = (y) => Math.min(height - 1, Math.max(0, y));
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += luma[y * width + clampX(x)];
    for (let x = 0; x < width; x++) {
      rowBlur[y * width + x] = sum / (2 * radius + 1);
      sum += luma[y * width + clampX(x + radius + 1)] - luma[y * width + clampX(x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += rowBlur[clampY(y) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = luma[y * width + x] - sum / (2 * radius + 1);
      sum += rowBlur[clampY(y + radius + 1) * width + x] - rowBlur[clampY(y - radius) * width + x];
    }
  }
  return { width, height, luma: out };
}

// 画像中心の円の内側の、2 枚のピアソン相関。
function correlation(a, b, maskRadius) {
  const { width, height } = a;
  const centerX = width / 2;
  const centerY = height / 2;
  let sumA = 0; let sumB = 0; let sumAA = 0; let sumBB = 0; let sumAB = 0; let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > maskRadius ** 2) continue;
      const va = a.luma[y * width + x];
      const vb = b.luma[y * width + x];
      sumA += va; sumB += vb; sumAA += va * va; sumBB += vb * vb; sumAB += va * vb; count++;
    }
  }
  const covariance = sumAB / count - (sumA / count) * (sumB / count);
  const varianceA = sumAA / count - (sumA / count) ** 2;
  const varianceB = sumBB / count - (sumB / count) ** 2;
  return covariance / Math.sqrt(Math.max(varianceA * varianceB, 1e-9));
}

// 物差しが同じ絵を 1、1 画素ずれた絵・薄い別の絵を NCC_MIN 未満と読むことを、撮影の前に確かめる。
function selfTest() {
  const size = 96;
  const random = (() => { let seed = 12345; return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; })();
  const luma = new Float32Array(size * size).map(() => random() * 255);
  const image = { width: size, height: size, luma };
  const shifted = { width: size, height: size, luma: new Float32Array(size * size) };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) shifted.luma[y * size + x] = luma[y * size + ((x + 1) % size)];
  const other = { width: size, height: size, luma: new Float32Array(size * size).map(() => random() * 255) };
  const mask = size / 2 - 4;
  const same = correlation(highPass(image, 3), highPass(image, 3), mask);
  const slid = correlation(highPass(image, 3), highPass(shifted, 3), mask);
  const unrelated = correlation(highPass(image, 3), highPass(other, 3), mask);
  if (!(same > 0.999 && slid < NCC_MIN && unrelated < NCC_MIN)) {
    throw new Error(`物差しの自己検査に失敗: 同じ ${same.toFixed(3)} ずれ ${slid.toFixed(3)} 別 ${unrelated.toFixed(3)}`);
  }
}

const decode = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

selfTest();
mkdirSync(outDir, { recursive: true });
const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: path.join(root, '.render-lab'), port, debugPort, profilePrefix: 'tepui-drag-', onEvent,
  requestTimeoutMs: 120_000,
});
const rows = [];
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(
    devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.captureAfterMove === 'function')",
    'the render lab to initialise',
  );
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
  for (const site of SITES) {
    for (const kind of KINDS) {
      for (const move of MOVES) {
        const base = {
          category: site.name, latitudeDeg: site.latitudeDeg, longitudeDeg: site.longitudeDeg,
          displayTime: START_DISPLAY_TIME_S, tierKmPerPx: TIER_KM_PER_PX,
        };
        const first = await devTools.evaluate(
          `window.renderLab.shootCloudDetailRandom('drag-base', ${JSON.stringify(base)})`);
        for (const [key, value] of kind.options) {
          await devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
        }
        // 描画設定を変えた直後のフレームは組み直しで崩れるので、落ち着かせてから動かし始める。
        let settled = await devTools.evaluate('window.renderLab.capture()');
        for (let count = 1; count < MAX_SETTLE_CAPTURES; count++) {
          await devTools.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve()))');
          const next = await devTools.evaluate('window.renderLab.capture()');
          if (next === settled) break;
          settled = next;
        }
        const kmPerPx = first.centerKmPerPx;
        const longitudeStepDeg = (move.stepPx * kmPerPx) / (111.32 * Math.cos((site.latitudeDeg * Math.PI) / 180));
        const viewAt = (k) => `{ earthLongitudeDeg: ${site.longitudeDeg + k * longitudeStepDeg} }, ${START_DISPLAY_TIME_S + k * move.timeStepS}`;
        const live = [];
        for (let k = 0; k <= FRAMES; k++) {
          live.push(await devTools.evaluate(`window.renderLab.captureAfterMove(${viewAt(k)})`));
        }
        const still = [];
        for (let k = 0; k <= FRAMES; k++) {
          let previous = await devTools.evaluate(`window.renderLab.captureAfterMove(${viewAt(k)})`);
          for (let count = 1; count < MAX_SETTLE_CAPTURES; count++) {
            await devTools.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve()))');
            const next = await devTools.evaluate('window.renderLab.capture()');
            if (next === previous) break;
            previous = next;
          }
          still.push(previous);
        }
        let worst = { k: -1, ncc: 2 };
        for (let k = 0; k <= FRAMES; k++) {
          const ncc = correlation(
            highPass(lumaOf(decode(live[k])), HIGH_PASS_RADIUS), highPass(lumaOf(decode(still[k])), HIGH_PASS_RADIUS), MASK_RADIUS);
          if (ncc < worst.ncc) worst = { k, ncc };
        }
        const pass = worst.ncc >= NCC_MIN;
        if (!pass) {
          const tag = `${site.name}-${kind.name}-${move.name}-k${worst.k}`;
          writeFileSync(path.join(outDir, `${tag}-live.png`), decode(live[worst.k]));
          writeFileSync(path.join(outDir, `${tag}-still.png`), decode(still[worst.k]));
        }
        rows.push({ site: site.name, kind: kind.name, move: move.name, worstFrame: worst.k, worstNcc: worst.ncc, pass });
      }
    }
  }
  if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
} finally {
  await session.close();
}

console.log(`ドラッグ中の雲の検査(連続 vs 静止の相関。合格は ${NCC_MIN} 以上)`);
for (const row of rows) {
  console.log(`${row.pass ? 'ok  ' : 'FAIL'} ${row.site.padEnd(5)} ${row.kind.padEnd(7)} ${row.move.padEnd(16)} `
    + `最悪 k=${String(row.worstFrame).padStart(2)} NCC=${row.worstNcc.toFixed(3)}`);
}
writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify({ nccMin: NCC_MIN, rows }, null, 2)}\n`);
if (rows.some((row) => !row.pass)) {
  console.error('基準を割った枠があります(.cloud-detail/drag/ の連続・静止の PNG を見てください)');
  process.exitCode = 1;
}
