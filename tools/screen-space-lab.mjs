// 近傍拡散補正の計測が使う、評価の組と、それを描画テスト環境で撮る口と、基準の置き場。撮影は走査の段とブルーノイズの
// seed を与え、表示の絵と浮動小数の中間ターゲットを受け取る。
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';
import { linearOfSrgbCodes } from './screen-space-error.mjs';

// リポジトリ根と、組んだ描画テスト環境、撮影組の置き場。
export const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
export const shotsDir = path.join(root, '.render-lab-shots');
const port = 8771;
const debugPort = 9447;
// 描画テスト環境の絵の寸法 [画素]。
export const WIDTH = 960;
export const HEIGHT = 540;

// 描画設定 screenSpaceDiffuse の値(src/render/pipeline/screen-space/screen-space-pass.ts)。
const MODE = { occlusion: 1, indirect: 2 };
// 全撮影へ重ねる描画設定。レンズ効果は明るい面の光を広げて誤差を混ぜるので切る。
const EVALUATION_GRAPHICS = { lens: false };

// 評価の組。set は tuning(調整用)・checking(確認用)・correctness(解析値との照合)・flicker(ちらつき)、mode は
// 描画設定 screenSpaceDiffuse の値、dolly はカメラの距離の倍率の常用対数。key は撮影名に、遮蔽の方式なら
// @occlusion、カメラを引いたなら @dolly<フレーム> を付けたもの。
const DOLLY_STEP = 0.0005;
const DOLLY_FRAMES = 6;
const entry = (set, caseName, shot, mode = MODE.indirect, dolly = 0) => {
  const suffix = `${mode === MODE.occlusion ? '@occlusion' : ''}${dolly ? `@dolly${Math.round(dolly / DOLLY_STEP)}` : ''}`;
  return { set, caseName, shot, mode, dolly, key: `${shot}${suffix}` };
};
export const ENTRIES = [
  ...['bay', 'bay-dark', 'bay-earth-open', 'bay-bounce'].map((shot) => entry('tuning', 'bay', shot)),
  ...['groove-ladder', 'groove-ladder-near', 'groove-ladder-far', 'groove-ladder-bounce']
    .map((shot) => entry('tuning', 'groove-ladder', shot)),
  ...['bay-distance-0.5x', 'bay-distance-2.5x', 'bay-truss', 'bay-edge'].map((shot) => entry('checking', 'bay', shot)),
  entry('checking', 'groove-ladder', 'groove-ladder-check'),
  ...['bay-earthshine', 'bay-earth-overhead', 'bay-earth-corner', 'bay-moon-open', 'bay-moon-corner']
    .flatMap((shot) => Object.values(MODE).map((mode) => entry('correctness', 'bay', shot, mode))),
  entry('correctness', 'bounce-cosine', 'bounce-cosine'),
  ...Array.from({ length: DOLLY_FRAMES }, (_, k) => entry('flicker', 'bay', 'bay', MODE.indirect, (k + 1) * DOLLY_STEP)),
];

// 走査の解像度 1/4 のフェードの外側 — 近傍の半径が描画バッファの画素でこれを超える面だけを測る。
const FADE_OUTER_PX = 8;
// 撮影 1 枚が、絵の落ち着きを待って撮る回数の上限。
const MAX_SETTLE_CAPTURES = 6;
// seed の列は黄金比の逆数の倍数の小数部。
const GOLDEN = 0.6180339887498949;
export const seedOf = (k) => (k * GOLDEN) % 1;

// いまの精細さの段(src/render/pipeline/screen-space/screen-space-pass.ts の SCAN_TIERS)。
export const TIERS = {
  low: { scale: 0.25, sliceCount: 2, stepCount: 3, denoiseRadius: 2 },
  medium: { scale: 0.25, sliceCount: 3, stepCount: 4, denoiseRadius: 2 },
  high: { scale: 0.25, sliceCount: 4, stepCount: 6, denoiseRadius: 2 },
};

// HEAD の短いハッシュ。
export const headHash = () => execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();

// ---- 撮影 ----

// 描画テスト環境の CDP の入口を包む。
function labOf(devTools) {
  const call = (expression) => devTools.evaluate(`window.renderLab.${expression}`);
  return {
    // 評価の組の 1 つ entry を表示する。
    async show(entry) {
      await call(`showShot(${JSON.stringify(entry.caseName)}, ${JSON.stringify(entry.shot)}, ${JSON.stringify({ ...EVALUATION_GRAPHICS, screenSpaceDiffuse: entry.mode })})`);
      if (entry.dolly) await call(`setView(${JSON.stringify({ cameraDistanceLog: entry.dolly })})`);
    },
    setTier: (tier) => call(`setScanTier(${JSON.stringify(tier)})`),
    setSeed: (seed) => call(`setScanSeed(${seed})`),
    setTarget: (target) => call(`setTarget(${JSON.stringify(target)})`),
    exposureFactor: () => call('exposureFactor()'),
    measureTiers: (tiers, rounds) => call(`measureTiers(${JSON.stringify(tiers)}, ${rounds})`),
    // いまの絵を、連続する 2 回が一致するまで撮り直して PNG の Buffer で返す。
    async capturePng() {
      let previous = await call('capture()');
      for (let count = 2; count <= MAX_SETTLE_CAPTURES; count++) {
        const next = await call('capture()');
        if (next === previous) return Buffer.from(next.slice(next.indexOf(',') + 1), 'base64');
        previous = next;
      }
      throw new Error(`capture did not settle within ${MAX_SETTLE_CAPTURES} captures`);
    },
    // 直前のフレームの中間ターゲット name の、画素ごとに先頭 channels 成分の Float32Array。CDP の 1 通の上限を
    // 超えないよう、行の塊ごとに受け取る。
    async readFloat(name, channels) {
      const [width, height] = await devTools.evaluate(`window.renderLab.readFloat(${JSON.stringify(name)})
        .then((image) => { window.__ssdFloat = image; return [image.width, image.height]; })`);
      const out = new Float32Array(width * height * channels);
      const rowsPerChunk = 64;
      for (let y0 = 0; y0 < height; y0 += rowsPerChunk) {
        const y1 = Math.min(height, y0 + rowsPerChunk);
        const base64 = await devTools.evaluate(`(() => {
          const { width, rgba } = window.__ssdFloat;
          const out = new Float32Array(${(y1 - y0)} * width * ${channels});
          for (let p = 0; p < out.length / ${channels}; p++) {
            for (let k = 0; k < ${channels}; k++) out[p * ${channels} + k] = rgba[(${y0} * width + p) * 4 + k];
          }
          const bytes = new Uint8Array(out.buffer);
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        })()`);
        const bytes = Buffer.from(base64, 'base64');
        out.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4), y0 * width * channels);
      }
      await devTools.evaluate('delete window.__ssdFloat');
      return out;
    },
  };
}

// いまの絵を線形 sRGB(画素ごとに 3 つ)で撮る。
export async function captureLinear(lab) {
  const { channels, data } = decodePng(await lab.capturePng());
  return linearOfSrgbCodes(data, channels, WIDTH * HEIGHT);
}

// .render-lab/ を開いた Chrome の上で work(lab) を走らせる。
export async function withLab(work) {
  const session = await openChromeSession({ serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-ss-' });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.showShot === 'function')",
      'the render lab to initialise');
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    return await work(labOf(devTools));
  } finally {
    await session.close();
  }
}

// entry を、段 tier の seed の列 seeds で撮り、表示(線形 sRGB)と、withDiffuse なら拡散照度(rgb)の平均を返す。
export async function averageOf(lab, tier, seeds, withDiffuse) {
  await lab.setTier(tier);
  const display = new Float32Array(WIDTH * HEIGHT * 3);
  const diffuse = withDiffuse ? new Float32Array(WIDTH * HEIGHT * 3) : null;
  for (const seed of seeds) {
    await lab.setSeed(seed);
    const frame = await captureLinear(lab);
    for (let i = 0; i < display.length; i++) display[i] += frame[i] / seeds.length;
    if (diffuse !== null) {
      const irradiance = await lab.readFloat('diffuse', 3);
      for (let i = 0; i < diffuse.length; i++) diffuse[i] += irradiance[i] / seeds.length;
    }
  }
  return { display, diffuse };
}

// ---- 基準 ----

// 基準の組の置き場。
export const referenceDirOf = (name) => path.join(shotsDir, 'ssd-reference', name);

export const writeFloats = (file, values) => writeFileSync(file, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
export const readFloats = (file) => {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
};

// 基準の組 name を読む。entry.key ごとの { display, diffuse, radius, normal, depth } と meta。
export function loadReference(name) {
  const dir = referenceDirOf(name);
  const meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const entries = Object.fromEntries(ENTRIES.map((entry) => {
    const file = (suffix) => path.join(dir, `${entry.key}.${suffix}`);
    const normal = decodePng(readFileSync(file('normal.png')));
    const depth = decodePng(readFileSync(file('depth.png')));
    return [entry.key, {
      display: readFloats(file('display.f32')),
      diffuse: entry.set === 'correctness' ? readFloats(file('diffuse.f32')) : null,
      radius: readFloats(file('radius.f32')),
      normal: linearOfSrgbCodes(normal.data, normal.channels, WIDTH * HEIGHT),
      depth: Uint8Array.from({ length: WIDTH * HEIGHT }, (_, p) => depth.data[p * depth.channels]),
    }];
  }));
  return { meta, entries };
}

// 近傍の半径 radius [画素] から、測る画素の印(背景と、1/4 の走査でもフェードの外にある面)。
export const maskOf = (radius) => Uint8Array.from(radius, (r) => (r === 0 || r > FADE_OUTER_PX ? 1 : 0));
