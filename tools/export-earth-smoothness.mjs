// src/assets/earth.jpg から、地表の滑らかさのテクスチャ src/assets/earth-smoothness.png
// (正距円筒、8bit グレースケール、0..255 が滑らかさ 0..1 = 1 − 粗さ)を焼く。
//
// **地表テクスチャの海と湖は一様な青の単色で塗られている。** 線形 RGB で青が赤の 13.5 倍
// あり、陸・氷・雪はどこも 1.5 倍を超えない — その間は空いているので、比に閾値を置けば
// 水面だけを取り出せる。この空きは 8192×4096 の全 texel を数えて確かめたもので、
// 閾値 WATER_BLUE_OVER_RED_LOW..HIGH の帯に入るのは海岸で混色された 1.8% だけ、
// 取り出される面積は cos(緯度)重みで 70.3%(実際の海洋被覆率 71% に一致する)。
// **地表テクスチャを差し替えたら測り直す。**
//
// JPEG の復号はヘッドレス Chrome に任せる(Node 側に復号器を持たないため)。
//
// 実行: node tools/export-earth-smoothness.mjs
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFatalEvents, openChromeSession } from './chrome-session.mjs';
import { encodeGrayPng } from './png.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(repoRoot, 'src', 'assets', 'earth.jpg');
const outPath = join(repoRoot, 'src', 'assets', 'earth-smoothness.png');
const port = 8768;
const debugPort = 9445;

// 出力の大きさ。地表テクスチャ(8192×4096)の半分。ハイライトの広がりは波面の傾斜が決めていて
// 海岸線の形では変わらないので、水陸の境が読める細かさがあればよい。
const WIDTH = 4096;
const HEIGHT = 2048;

// 海面の滑らかさ。Cox & Munk (1954) の太陽光鏡面反射から得た波面傾斜の統計 — 平均二乗傾斜
// σ² = 0.003 + 0.00512 W(W は海上風速 [m/s])に外洋の平均風速 7 m/s を入れて σ = 0.197 を
// 得る。これを微小面分布の α と読み、three の α = 粗さ² から粗さ 0.44 を得た残り。
const WATER_SMOOTHNESS = 1 - 0.44;
// 水面と見なす、線形 RGB の青と赤の比の下限・上限。海と陸の間の空きに置く。
const WATER_BLUE_OVER_RED_LOW = 3;
const WATER_BLUE_OVER_RED_HIGH = 8;
// 比を取る前に赤へ張る床。深海には赤が 0 まで落ちる texel がある。
const WATER_RED_FLOOR = 1e-3;

// 1 度に読み出す base64 の長さ。8M texel をまとめて返すと CDP の 1 応答が数十 MB になる。
const CHUNK_CHARS = 4 << 20;

// 画像を canvas へ縮小して描き、texel ごとの滑らかさを 0..255 で並べた base64 を
// window.baked へ置くページ側の手続き。
const BAKE_SCRIPT = `(async () => {
  const image = new Image();
  image.src = 'earth.jpg';
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = ${WIDTH};
  canvas.height = ${HEIGHT};
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, ${WIDTH}, ${HEIGHT});
  const source = context.getImageData(0, 0, ${WIDTH}, ${HEIGHT}).data;
  const toLinear = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const out = new Uint8Array(${WIDTH * HEIGHT});
  for (let i = 0; i < out.length; i++) {
    const ratio = toLinear(source[i * 4 + 2]) / Math.max(toLinear(source[i * 4]), ${WATER_RED_FLOOR});
    const t = Math.min(1, Math.max(0, (ratio - ${WATER_BLUE_OVER_RED_LOW}) / ${WATER_BLUE_OVER_RED_HIGH - WATER_BLUE_OVER_RED_LOW}));
    out[i] = Math.round(255 * ${WATER_SMOOTHNESS} * (t * t * (3 - 2 * t)));
  }
  // 分けて符号化するので、境目に詰め物('=')が入らないよう 3 の倍数ずつ渡す。
  let base64 = '';
  for (let at = 0; at < out.length; at += 32766) {
    base64 += btoa(String.fromCharCode.apply(null, out.subarray(at, at + 32766)));
  }
  window.baked = base64;
  return base64.length;
})()`;

// ページ側で焼いた base64 を分割して受け取り、1 本に繋ぐ。
async function readBaked(devTools, length) {
  let base64 = '';
  for (let at = 0; at < length; at += CHUNK_CHARS) {
    base64 += await devTools.evaluate(`window.baked.slice(${at}, ${at + CHUNK_CHARS})`);
  }
  return base64;
}

async function main() {
  // 静的サーバは 1 つのディレクトリだけを配るので、原画と入口の HTML を仮置き場へ集める。
  const stage = mkdtempSync(join(tmpdir(), 'tepui-smoothness-'));
  copyFileSync(sourcePath, join(stage, 'earth.jpg'));
  writeFileSync(join(stage, 'index.html'), '<!doctype html><meta charset="utf-8"><title>bake</title>');

  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: stage, port, debugPort, profilePrefix: 'tepui-smoothness-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    const length = await devTools.evaluate(BAKE_SCRIPT);
    const gray = Buffer.from(await readBaked(devTools, length), 'base64');
    if (gray.length !== WIDTH * HEIGHT) throw new Error(`baked ${gray.length} bytes, expected ${WIDTH * HEIGHT}`);
    if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);

    const png = encodeGrayPng(WIDTH, HEIGHT, gray);
    writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${WIDTH}x${HEIGHT}, ${(png.length / 1024).toFixed(0)} KB)`);
  } finally {
    await session.close();
    rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
