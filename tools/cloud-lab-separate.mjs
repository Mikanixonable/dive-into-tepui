// 実写の雲テクスチャ(src/assets/8k_clouds.jpg)を、生成側の層境界と同じ 3 チャンネルへ
// 推定分離して .cloud-lab/separated/ に書く。描画側が仮テクスチャとして先に使えるようにする。
//   coverage.png    厚い雲の被覆率(輝度をそのまま被覆率とみなす近似)
//   cloud-top.png   雲頂高度(0..1 = 0..15000 m)
//   translucent.png 薄い雲の鉛直光学的厚み τ(0..1。輝度 v から τ = −ln(1−v))
// 検分用に veil.png(巻雲の輝度)と recomposed.png(3 チャンネルからのスクリーン再合成 —
// 入力と見比べて分離の癖を探す)も書く。分離の方法と調整パラメータは tools/cloud-separation.mjs。
// JPEG の復号だけヘッドレス Chrome のキャンバスに頼る(依存を増やさない)。
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { fieldToGrayPng } from './gray-image.mjs';
import { estimateCloudTop, separateClouds } from './cloud-separation.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.cloud-lab', 'separated');
// 静的サーバは index.html を配れないと readiness 判定に落ちるので、jpg の写しと空の
// index.html を置いた一時ディレクトリを配る。
const serveDir = path.join(root, '.cloud-lab', 'separate-input');
const port = 8770;
const debugPort = 9447;
// 一度に転送する行数。R チャンネルだけを base64 で運ぶ。
const BAND_ROWS = 256;

// 実写をヘッドレス Chrome で復号し、輝度(R チャンネル)の場にして返す。
async function loadPhoto() {
  mkdirSync(serveDir, { recursive: true });
  writeFileSync(path.join(serveDir, 'index.html'), '<!doctype html>');
  copyFileSync(path.join(root, 'src', 'assets', '8k_clouds.jpg'), path.join(serveDir, '8k_clouds.jpg'));
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir, port, debugPort, profilePrefix: 'tepui-cloud-separate-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/8k_clouds.jpg` });
    await waitFor(devTools, 'document.images.length > 0 && document.images[0].complete', 'the photo to load');
    const [width, height] = await devTools.evaluate(`(() => {
      const img = document.images[0];
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(img, 0, 0);
      window.photoContext = context;
      return [canvas.width, canvas.height];
    })()`);
    const data = new Float32Array(width * height);
    for (let y0 = 0; y0 < height; y0 += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, height - y0);
      const base64 = await devTools.evaluate(`(() => {
        const rgba = window.photoContext.getImageData(0, ${y0}, ${width}, ${rows}).data;
        const bytes = new Uint8Array(rgba.length / 4);
        for (let i = 0; i < bytes.length; i++) bytes[i] = rgba[i * 4];
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      })()`);
      const bytes = Buffer.from(base64, 'base64');
      for (let i = 0; i < bytes.length; i++) data[y0 * width + i] = bytes[i] / 255;
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
    return { width, height, data };
  } finally {
    await session.close();
  }
}

function mean(field) {
  let sum = 0;
  for (const v of field.data) sum += v;
  return sum / field.data.length;
}

async function main() {
  const photo = await loadPhoto();
  console.log(`decoded ${photo.width}x${photo.height}`);
  // 正距円筒の 1 px が張る長さ [km]。横は緯度で縮む(極の発散は頭打ち)。
  const kmPerPxEquator = 40075 / photo.width;
  const kmPerPxAt = (y) => {
    const latitude = ((photo.height / 2 - y) / photo.height) * Math.PI;
    return { x: kmPerPxEquator * Math.max(0.1, Math.cos(latitude)), y: kmPerPxEquator };
  };

  const separated = separateClouds(photo, kmPerPxAt, true);
  const cloudTop = estimateCloudTop(separated.thick, kmPerPxAt, true);
  const translucent = {
    width: photo.width,
    height: photo.height,
    data: Float32Array.from(separated.veil.data, (v) => Math.min(1, -Math.log(1 - Math.min(0.98, v)))),
  };
  // 3 チャンネルからの往復: coverage と τ をスクリーン合成へ戻すと入力に一致するはず。
  const recomposed = {
    width: photo.width,
    height: photo.height,
    data: Float32Array.from(separated.thick.data, (c, i) =>
      1 - (1 - c) * Math.exp(-translucent.data[i])),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'coverage.png'), fieldToGrayPng(separated.thick));
  writeFileSync(path.join(outDir, 'cloud-top.png'), fieldToGrayPng(cloudTop));
  writeFileSync(path.join(outDir, 'translucent.png'), fieldToGrayPng(translucent));
  writeFileSync(path.join(outDir, 'veil.png'), fieldToGrayPng(separated.veil));
  writeFileSync(path.join(outDir, 'recomposed.png'), fieldToGrayPng(recomposed));

  // 分離の量の見当と、しきい値の調整の手がかり(等方な細かさの分布)。
  console.log(`means: photo ${mean(photo).toFixed(3)} = thick ${mean(separated.thick).toFixed(3)}`
    + ` ⊕ veil ${mean(separated.veil).toFixed(3)} (recomposed ${mean(recomposed).toFixed(3)})`);
  for (const [label, field] of [['isotropy(λ2)', separated.isotropy], ['energy(λ1)', separated.energy]]) {
    const sorted = Float64Array.from(field.data).sort();
    const percentileOf = (q) => sorted[Math.floor(sorted.length * q)].toFixed(3);
    console.log(`${label} percentiles: 50% ${percentileOf(0.5)} / 75% ${percentileOf(0.75)}`
      + ` / 90% ${percentileOf(0.9)} / 99% ${percentileOf(0.99)}`);
  }
  console.log(`wrote 5 PNGs to ${path.relative(root, outDir)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
