// 建造カタログ用サムネイルの書き出し。描画テスト環境の thumbnail-<modelId>-black / -white
// ケースを同じ構図で撮り、画素ごとの差からモジュールの覆い(α)と本来の色を復元し、
// 中央の正方形を 128×128 の透過 PNG として src/assets/module-thumbnails/<modelId>.png へ書く。
// 走らせる前に .render-lab のビルドが要る(npm run export-module-thumbnails はビルドから始まる)。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

/* global Image, document -- composeThumbnail は .toString() でソースを取り、ページ内で評価する。 */

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outDir = path.join(root, 'src', 'assets', 'module-thumbnails');
const port = 8771;
const debugPort = 9447;
const SIZE = 128;
// 黒背景・白背景の PNG データ URL をページ内へ置く名前。
const PENDING = '__moduleThumbnails';
// ヘッドレス描画は時折撮影が落ち着かずに失敗するので、モジュールごとに撮り直す回数の上限。
const MAX_ATTEMPTS = 3;

// ページ内で、同じ構図の黒背景・白背景の2枚から透過サムネイルを組む。
// 画素を fg·a + bg·(1−a) と仮定すると、2枚の差は (bgw−bgb)·(1−a) なので、背景色を隅から
// 測れば覆い a と本来の色 fg が解ける。返すのは中央の正方形を size へ縮小した透過 PNG の
// データ URL と、空でないことの検査用に非透明画素数・平均輝度。
async function composeThumbnail(blackUrl, whiteUrl, size) {
  const load = (url) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('thumbnail source image failed to decode'));
    image.src = url;
  });
  const [black, white] = await Promise.all([load(blackUrl), load(whiteUrl)]);
  const side = Math.min(black.width, black.height);
  const x0 = Math.floor((black.width - side) / 2);
  const scratch = document.createElement('canvas');
  scratch.width = side;
  scratch.height = side;
  const context = scratch.getContext('2d', { willReadFrequently: true });
  context.drawImage(black, x0, 0, side, side, 0, 0, side, side);
  const pixelsBlack = context.getImageData(0, 0, side, side).data;
  context.drawImage(white, x0, 0, side, side, 0, 0, side, side);
  const pixelsWhite = context.getImageData(0, 0, side, side).data;
  // 背景色は隅の 8×8 の平均で測る。理屈の上では背景は全面が同じ色。
  const measureBackground = (pixels) => {
    const sum = [0, 0, 0];
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const at = (y * side + x) * 4;
        sum[0] += pixels[at];
        sum[1] += pixels[at + 1];
        sum[2] += pixels[at + 2];
      }
    }
    return sum.map((v) => v / 64);
  };
  const bgBlack = measureBackground(pixelsBlack);
  const bgWhite = measureBackground(pixelsWhite);
  const delta = [0, 1, 2].map((c) => bgWhite[c] - bgBlack[c]);
  const deltaNorm = delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2;
  if (deltaNorm < 1) throw new Error('thumbnail backdrops did not differ');
  const frame = context.createImageData(side, side);
  const out = frame.data;
  for (let i = 0; i < side * side; i += 1) {
    const at = i * 4;
    const diff = [0, 1, 2].map((c) => pixelsWhite[at + c] - pixelsBlack[at + c]);
    const alpha = Math.min(1, Math.max(
      0, 1 - (diff[0] * delta[0] + diff[1] * delta[1] + diff[2] * delta[2]) / deltaNorm,
    ));
    if (alpha <= 1 / 255) continue;
    for (let c = 0; c < 3; c += 1) {
      const fromBlack = pixelsBlack[at + c] - bgBlack[c] * (1 - alpha);
      const fromWhite = pixelsWhite[at + c] - bgWhite[c] * (1 - alpha);
      out[at + c] = Math.min(255, Math.max(0, Math.round((fromBlack + fromWhite) / (2 * alpha))));
    }
    out[at + 3] = Math.round(alpha * 255);
  }
  context.putImageData(frame, 0, 0);
  const dest = document.createElement('canvas');
  dest.width = size;
  dest.height = size;
  const destContext = dest.getContext('2d', { willReadFrequently: true });
  destContext.imageSmoothingQuality = 'high';
  destContext.drawImage(scratch, 0, 0, size, size);
  const final = destContext.getImageData(0, 0, size, size).data;
  let opaque = 0;
  let luminance = 0;
  for (let i = 0; i < size * size; i += 1) {
    const at = i * 4;
    if (final[at + 3] === 0) continue;
    opaque += 1;
    luminance += 0.2126 * final[at] + 0.7152 * final[at + 1] + 0.0722 * final[at + 2];
  }
  return { png: dest.toDataURL('image/png'), opaque, meanLuminance: opaque === 0 ? 0 : luminance / opaque };
}

// ケース名 thumbnail-<modelId>-black / -white の対から、modelId の一覧を引く。
function thumbnailModelIds(names) {
  const modelIds = [];
  for (const name of names) {
    const match = /^thumbnail-(.+)-black$/.exec(name);
    if (match !== null && names.includes(`thumbnail-${match[1]}-white`)) modelIds.push(match[1]);
  }
  return modelIds;
}

async function main() {
  if (!existsSync(path.join(buildDir, 'index.html'))) {
    throw new Error('.render-lab is not built; run `npm run export-module-thumbnails`');
  }
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-module-thumbs-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    // レンダラーの init() が終わるまで撮れない。ページが失敗を文字で出していたらそれを読む。
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shoot === 'function')",
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    const names = await devTools.evaluate('window.renderLab.cases');
    const modelIds = thumbnailModelIds(names).sort();
    if (modelIds.length === 0) throw new Error('no thumbnail-* cases were registered');

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await devTools.evaluate(`window.${PENDING} = {}`);
    const compose = composeThumbnail.toString();
    for (const modelId of modelIds) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          for (const backdropName of ['black', 'white']) {
            const caseName = `thumbnail-${modelId}-${backdropName}`;
            await devTools.evaluate(
              `window.renderLab.shoot(${JSON.stringify(caseName)}).then((pngs) => {` +
              ` window.${PENDING}.${backdropName} = pngs[${JSON.stringify(caseName)}]; })`,
            );
          }
          const { png, opaque, meanLuminance } = await devTools.evaluate(
            `(${compose})(window.${PENDING}.black, window.${PENDING}.white, ${SIZE})`,
          );
          // 全画素が透明・全画素が不透明・真っ黒は、撮影か覆いの復元が壊れている兆候なので失敗にする。
          if (opaque === 0 || opaque === SIZE * SIZE || meanLuminance <= 0) {
            throw new Error(`thumbnail ${modelId} looks broken (opaque=${opaque}, meanLuminance=${meanLuminance})`);
          }
          writeFileSync(
            path.join(outDir, `${modelId}.png`), Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'),
          );
          console.log(`wrote ${modelId}.png (opaque=${opaque}, meanLum=${meanLuminance.toFixed(1)})`);
          break;
        } catch (e) {
          if (attempt === MAX_ATTEMPTS) throw e;
          console.warn(`retry ${modelId} (attempt ${attempt}/${MAX_ATTEMPTS}): ${e.message ?? e}`);
        }
      }
    }
    await devTools.evaluate(`delete window.${PENDING}`);
    if (fatalEvents.length > 0) throw new Error(`Page reported errors during shooting:\n${fatalEvents.join('\n')}`);
    console.log(`Wrote ${modelIds.length} thumbnails to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
