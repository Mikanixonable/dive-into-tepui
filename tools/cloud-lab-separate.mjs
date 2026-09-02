// 実写の分離環境(.cloud-lab/separate.html)をヘッドレス Chrome で開き、分離した各チャンネルを
// PNG に書く。層境界の 3 チャンネル(被覆率・雲頂高度・薄い雲 τ)は描画側が仮テクスチャとして
// 読む生成アセットなので、**1 枚の RGB へ詰めて** src/assets/ へ直接焼く(export-climate などと
// 同じ流儀)。veil(巻雲の輝度)と recomposed(再合成 — 入力と見比べて分離の癖を探す)は検分用で
// .cloud-lab/separated/ へ。分離の方法と調整パラメータは tools/cloud-lab/separation-pipeline.ts。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodeRedPng, fieldToGrayPng } from './gray-image.mjs';
import { encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const assetsDir = path.join(root, 'src', 'assets');
const outDir = path.join(buildDir, 'separated');
const port = 8770;
const debugPort = 9447;

// 仮テクスチャ 1 枚へ詰める量と、その並び。**RGB の割り当ては生成側の出力規約に合わせる**
// — src/render/cloud/cloud-field.ts が焼く vec4(被覆率, 雲頂高度, 薄い雲 τ) と同じ順。
const FIELD_VIEWS = ['coverage', 'cloudTop', 'translucent'];
const FIELD_FILE = path.join(assetsDir, 'cloud-field.png');

// 検分用に別途撮る量と書き先。
const INSPECTION_SHOTS = [
  ['veil', path.join(outDir, 'veil.png')],
  ['recomposed', path.join(outDir, 'recomposed.png')],
];

// 3 つの 0..1 の場を、R/G/B へ 8bit で量子化した 1 枚の走査線へ詰める。
function packRgb(fields) {
  const [r, g, b] = fields;
  const rgb = new Uint8Array(r.width * r.height * 3);
  for (let i = 0; i < r.width * r.height; i++) {
    rgb[i * 3] = quantize(r.data[i]);
    rgb[i * 3 + 1] = quantize(g.data[i]);
    rgb[i * 3 + 2] = quantize(b.data[i]);
  }
  return encodeRgbPng(r.width, r.height, rgb);
}

function quantize(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-separate-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/separate.html` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudSeparate === 'object')",
      'the separation page to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Separation page failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    // 撮影はキャンバス由来の RGBA PNG を返す。仮テクスチャは 3 つの量を RGB へ詰め直した 1 枚、
    // 検分用はグレースケール 8bit — どちらも R 成分だけが量を持つ。
    const capture = async (view) => {
      const dataUrl = await devTools.evaluate(`window.cloudSeparate.capture(${JSON.stringify(view)})`);
      return decodeRedPng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    };
    const fields = [];
    for (const view of FIELD_VIEWS) fields.push(await capture(view));
    writeFileSync(FIELD_FILE, packRgb(fields));
    console.log(`wrote ${path.relative(root, FIELD_FILE)}`);
    for (const [view, file] of INSPECTION_SHOTS) {
      writeFileSync(file, fieldToGrayPng(await capture(view)));
      console.log(`wrote ${path.relative(root, file)}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
    // 分離の質の指標(意味は tools/cloud-lab/separate-main.ts)。調整の前後比較の記録用。
    const metrics = await devTools.evaluate('window.cloudSeparate.metrics()');
    console.log(`相関 全体 ${metrics.corrAll.toFixed(3)} / 150-600km ${metrics.corrBand.toFixed(3)}`
      + ` | 平均 veil ${metrics.veilMean.toFixed(3)} / thick ${metrics.thickMean.toFixed(3)}`);
    console.log('Wrote the provisional texture to src/assets and 2 inspection PNGs to .cloud-lab/separated');
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
