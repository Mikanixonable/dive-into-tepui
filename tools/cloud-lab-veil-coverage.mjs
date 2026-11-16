// かなとこ(脱出水ベール)の被覆率の計測。cap ごとに veil ビューを撮り、
// 明るい画素の割合を返す。調整前後の比較に使う。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'shots-veil-coverage');
const port = 8773;
const debugPort = 9450;

const CAPS = [
  { name: 'amazon', latitude: -3, longitude: -60, radius: 6 },
  { name: 'westpacific', latitude: 8, longitude: 145, radius: 6 },
  { name: 'southernocean', latitude: -55, longitude: -150, radius: 8 },
  { name: 'itcz', latitude: 5, longitude: -165, radius: 8 },
  // 粗い写し(全球相当の texel) — 粒が死ぬので活発度の床が発火を担う。
  { name: 'global-wpac', latitude: 8, longitude: 145, radius: 60 },
  { name: 'global-itcz', latitude: 5, longitude: -165, radius: 60 },
];
const SHOT_HOURS = [14];

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-lab-veilcov-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/?capture-only` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudLab === 'object')",
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    mkdirSync(outDir, { recursive: true });
    for (const cap of CAPS) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${cap.latitude}, ${cap.longitude}, ${cap.radius})`);
      for (const hours of SHOT_HOURS) {
        await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
        for (const view of ['detrain', 'veil', 'convectiveActivity']) {
        await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(view)})`);
        const dataUrl = await devTools.evaluate('window.cloudLab.capture()');
        writeFileSync(
          path.join(outDir, `${cap.name}-${view}-${hours}h.png`),
          Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        const stats = await devTools.evaluate(`(async () => {
          const dataUrl = await window.cloudLab.capture();
          const img = new Image();
          await new Promise((res) => { img.onload = res; img.src = dataUrl; });
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let lit = 0, strong = 0, total = 0, sum = 0;
          // 右面(cap 円板の内側)だけ別に数える — 左の全球面と四隅の黒を除いて
          // cap 内の実被覆率を出す。円板は右面の正方形(512px)内に直径 512 で収まる。
          let capLit = 0, capTotal = 0;
          const hist = new Array(10).fill(0);
          for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
              const v = d[(y * c.width + x) * 4];
              total++; sum += v;
              if (v > 32) lit++;
              if (v > 128) strong++;
              hist[Math.min(9, Math.floor(v / 25.6))]++;
            }
          }
          // cap 円板の内側だけ走査し直す(面の境は幅の 2/3、円板の中心は右面中央)。
          const x0 = Math.floor(c.width * 2 / 3), s = c.width - x0;
          const cx = x0 + s / 2, cy = c.height / 2, rr = (s / 2) * (s / 2);
          for (let y = 0; y < c.height; y++) {
            for (let x = x0; x < c.width; x++) {
              const dx = x - cx, dy = y - cy;
              if (dx * dx + dy * dy > rr) continue;
              capTotal++;
              if (d[(y * c.width + x) * 4] > 32) capLit++;
            }
          }
          return { lit: lit / total, strong: strong / total, mean: sum / total, hist,
            capLit: capLit / capTotal };
        })()`);
        console.log(`${cap.name} ${view} ${hours}h: lit=${(stats.lit * 100).toFixed(1)}% cap=${(stats.capLit * 100).toFixed(1)}% strong=${(stats.strong * 100).toFixed(1)}% mean=${stats.mean.toFixed(1)} hist(>0.7,>0.8,>0.9)=${stats.hist.slice(7).map(h => (h * 100 / (stats.hist.reduce((a, b) => a + b, 0)) || 1).toFixed(1)).join('/')}`);
        }
      }
    }
    if (fatalEvents.length > 0) {
      console.error('fatal events:', fatalEvents);
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
