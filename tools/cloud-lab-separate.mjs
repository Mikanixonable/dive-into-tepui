// 実写の分離環境(.cloud-lab/separate.html)をヘッドレス Chrome で開き、分離した各チャンネルを
// PNG に書く。積雲の量・巻雲の量・巻雲の筋の向きは描画側が仮テクスチャとして読む生成アセット
// なので、**1 枚の RGBA へ詰めて** src/assets/ へ直接焼く(export-climate などと同じ流儀)。
// thick(厚い雲の不透明度)・veil(巻雲の輝度)・recomposed(再合成 — 入力と見比べて分離の癖を探す)は
// 検分と計測(tools/cloud-lab-compare.mjs が実写側の参照として読む)用で .cloud-lab/separated/ へ。分離の方法と調整パラメータは tools/cloud-lab/separation-pipeline.ts。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodeChannelPng, decodeRedPng, fieldToGrayPng, quantize } from './gray-image.mjs';
import { encodeRgbaPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const assetsDir = path.join(root, 'src', 'assets');
const outDir = path.join(buildDir, 'separated');
const port = 8771;
const debugPort = 9447;

// 仮テクスチャ 1 枚へ詰める量と、その並び。**RGBA の割り当ては生成側の出力規約に合わせる**
// — cloudFieldTexelFromSample(src/render/cloud/cloud-field-sample.ts)が焼く
// vec4(積雲の量, 巻雲の量, 筋の倍角ベクトルの x, y) と同じ順。ただし符号付き(−1..1)の
// 倍角ベクトルは PNG へ入る 0..1 へ畳み直して置く(読み手が ×2−1 で戻す)。
const FIELD_VIEWS = ['cumulus', 'cirrus', 'cirrusFlowPacked'];
const FIELD_FILE = path.join(assetsDir, 'cloud-field.png');

// 検分と計測用に別途撮る量と書き先。
const INSPECTION_SHOTS = [
  ['thick', path.join(outDir, 'thick.png')],
  ['veil', path.join(outDir, 'veil.png')],
  ['recomposed', path.join(outDir, 'recomposed.png')],
];

// 4 つの 0..1 の場を、R/G/B/A へ 8bit で量子化した 1 枚の走査線へ詰める。A は透明率では
// なく倍角ベクトルの y 成分なので、**前乗算や RGB との合成をどこにも入れない** — 値は
// 素の 8bit のまま PNG へ行く。
function packRgba(fields) {
  const [r, g, b, a] = fields;
  const rgba = new Uint8Array(r.width * r.height * 4);
  for (let i = 0; i < r.width * r.height; i++) {
    rgba[i * 4] = quantize(r.data[i]);
    rgba[i * 4 + 1] = quantize(g.data[i]);
    rgba[i * 4 + 2] = quantize(b.data[i]);
    rgba[i * 4 + 3] = quantize(a.data[i]);
  }
  return encodeRgbaPng(r.width, r.height, rgba);
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-separate-',
    // 8k 全面のパイプラインと読み出しは、ソフトウェア WebGPU では 1 枚の撮影が既定の 60 秒を
    // 超える(実測: 初回の撮影 ≈ 66 秒 — 初期のパイプラインの滞留分を含む)。この駆動だけ
    // 上限を 10 分へ延ばす。
    requestTimeoutMs: 600_000,
    onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/separate.html?capture-only` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.cloudSeparate === 'object')",
      'the separation page to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Separation page failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    // view の量を撮って場にする。撮影はキャンバス由来の RGBA PNG で、量は R 成分にある。
    const capture = async (view) => {
      const dataUrl = await devTools.evaluate(`window.cloudSeparate.capture(${JSON.stringify(view)})`);
      return decodeRedPng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    };
    const fields = [];
    for (const view of FIELD_VIEWS) fields.push(await capture(view));
    // cirrusFlowPacked は倍角ベクトルの畳んだ 2 成分を R・G へ写した表示。撮影の G 成分は
    // 別にデコードし直して A へ並べる。
    const flowPng = await devTools.evaluate(`window.cloudSeparate.capture('cirrusFlowPacked')`);
    const flowG = decodeChannelPng(
      Buffer.from(flowPng.slice(flowPng.indexOf(',') + 1), 'base64'), 1);
    writeFileSync(FIELD_FILE, packRgba([fields[0], fields[1], fields[2], flowG]));
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
