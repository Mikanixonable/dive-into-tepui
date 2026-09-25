// 遮蔽と照り返しの画質の計測。ヘッドレス Chrome で .render-lab/ を開き、荷室(bay)を地球照だけで照らした構図
// (bay-earthshine の撮影と同じ向き)を精細さの段ごとにデバッグ表示で撮って <out-dir> へ書き、基準の組
// <reference-dir> の高設定と比べた指標を表にする。基準を省くと <out-dir> 自身の高設定と比べる。
//
// 使い方: node tools/render-lab-screen-space-metrics.mjs <out-dir> [<reference-dir>]。dir は相対ならリポジトリ根から。
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
//
// 値はどれも、撮った PNG を sRGB と PBR Neutral から戻した線形の値(露出を掛けた目盛り)で測る。
// - 窓: 平らな床の 5×5 の窓。偏り・RMS 誤差・誤差の標準偏差を、基準の窓の平均輝度に対する割合 [%] で出す。
// - 接触影: 壁の足元から床へ引いた輝度の断面。足元の暗さ 1 − 足元 / 遠く と、その半分まで戻る距離 [px] を、
//   基準との差で出す。
// - 照り返し: 窓の「遮蔽と照り返し」と「遮蔽」の差の RGB の和を、基準の同じ差で割った比。
// - 境界の漏れ: G バッファの法線・深度の境界から 2 画素以内の面の、基準に対する RMS 誤差 [%]。
// - 連続フレーム差: カメラを少しずつ引いた連続フレームどうしの、境界の帯の外の面の平均絶対差 [%]。
// - 負の画素: 拡散照度(方式オフ)+ 復元後の補正 が負になる画素の数。PNG の量子化の幅の外で確かに負なものと、
//   幅の中で負でありうるもの。復元後の補正を表示できないビルドでは測らない。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const port = 8771;
const debugPort = 9447;

const USAGE = 'usage: node tools/render-lab-screen-space-metrics.mjs <out-dir> [<reference-dir>]';

// 描画設定 screenSpaceDiffuse / screenSpaceQuality の値(src/render/pipeline/screen-space/screen-space-pass.ts)。
const MODE = { off: 0, occlusion: 1, indirect: 2 };
const QUALITIES = [{ label: '低', value: 0 }, { label: '中', value: 1 }, { label: '高', value: 2 }];
// 基準にする精細さ。
const REFERENCE_QUALITY = 2;
// 荷室の既定の構図へ重ねる観察の向き。恒星を床の真下へ置き、見えている面を地球照と環境光だけで照らす。
const VIEW = { sunAzimuthDeg: 0, sunElevationDeg: -90 };
// 露出補正。床の拡散照度が、トーンマッピングの圧縮の掛からない明るさ(線形 0.76 未満)に写る値。
const EXPOSURE_COMPENSATION = 0.25;
// 復元後の補正のデバッグ表示のボタンの名前(src/render/pipeline/debug-target.ts)。
const CORRECTION_LABEL = '拡散照度補正';

// 読みどころ(960×540 の画素、tools/render-lab/bay-cases.ts の注記)。窓はこれを中心とする 5×5。
const WINDOWS = {
  'P_in': [412, 179],
  'P_base': [507, 189],
  'P_bleed': [704, 386],
  'P_glow': [547, 225],
};
const WINDOW_HALF = 2;
// 接触影の断面。start から toward の向きへ進んで壁に当たったところを足元とし、逆向きに PROFILE_LENGTH 画素まで、
// 断面と直交する ±PROFILE_HALF_WIDTH 画素を平均して読む。
const PROFILES = {
  'P_base': { start: [507, 189], toward: [0, -1] },
  'P_bleed': { start: [704, 386], toward: [1, 0] },
};
const PROFILE_LENGTH = 40;
const PROFILE_HALF_WIDTH = 10;
// 足元と遠くの断面の範囲 [px]。
const PROFILE_NEAR = [1, 3];
const PROFILE_FAR = [30, 40];
// 照り返しを読む窓。
const BOUNCE_WINDOWS = ['P_glow', 'P_bleed'];
// 境界とみなす隣の画素との法線のなす角の余弦と、深度の表示の差 [LSB]、境界の帯の幅 [px]。
const EDGE_NORMAL_COS = Math.cos(Math.PI / 6);
const EDGE_DEPTH_LSB = 3;
const EDGE_BAND = 2;
// カメラを引く 1 フレームぶんの距離の倍率の常用対数と、フレームの数。
const DOLLY_STEP = 0.0005;
const DOLLY_FRAMES = 6;
// 撮影 1 枚が、絵の落ち着きを待って撮る回数の上限。
const MAX_SETTLE_CAPTURES = 6;

// ---- 撮影 ----

// いま画面に出ているものを、連続する 2 回が一致するまで撮り直して PNG の Buffer で返す。
async function captureSettled(devTools, name) {
  let previous = await devTools.evaluate('window.renderLab.capture()');
  for (let count = 2; count <= MAX_SETTLE_CAPTURES; count++) {
    const next = await devTools.evaluate('window.renderLab.capture()');
    if (next === previous) return Buffer.from(next.slice(next.indexOf(',') + 1), 'base64');
    previous = next;
  }
  throw new Error(`capture "${name}" did not settle within ${MAX_SETTLE_CAPTURES} captures`);
}

// 全段を撮って outDir へ書き、段ごとの GPU の中央値 [ms] を返す。
async function captureSet(devTools, outDir) {
  const set = (key, value) => devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${value})`);
  const target = (id) => devTools.evaluate(`window.renderLab.setTarget(${JSON.stringify(id)})`);
  const view = (changes) => devTools.evaluate(`window.renderLab.setView(${JSON.stringify(changes)})`);
  const save = async (name) => {
    writeFileSync(path.join(outDir, `${name}.png`), await captureSettled(devTools, name));
    console.log(`shot ${name}`);
  };
  const hasCorrection = await devTools.evaluate(`[...document.querySelectorAll('[role=button]')]
    .some((b) => b.textContent === ${JSON.stringify(CORRECTION_LABEL)})`);
  await set('exposureCompensation', EXPOSURE_COMPENSATION);
  const gpu = {};
  for (const { value: q } of QUALITIES) {
    await set('screenSpaceDiffuse', MODE.indirect);
    await set('screenSpaceQuality', q);
    // 計測はケースを出し直して構図を既定へ戻すので、撮る前に呼ぶ。
    const measured = await devTools.evaluate(`window.renderLab.measure('bay', ${JSON.stringify(VIEW)})`);
    gpu[q] = Object.fromEntries(['照り返し源', '近傍拡散走査', '近傍拡散復元', 'マテリアル']
      .map((row) => [row, measured.gpuSupported ? measured.gpuPassMs[row]?.p50 ?? null : null]));
    await target('diffuse');
    await save(`q${q}-diffuse`);
    for (let k = 1; k <= DOLLY_FRAMES; k++) {
      await view({ cameraDistanceLog: k * DOLLY_STEP });
      await save(`q${q}-dolly-${k}`);
    }
    await view({ cameraDistanceLog: 0 });
    if (hasCorrection) {
      await target('correction');
      await save(`q${q}-correction`);
      await target('diffuse');
    }
    await set('screenSpaceDiffuse', MODE.occlusion);
    await save(`q${q}-occlusion-diffuse`);
  }
  // 方式によらない G バッファと、補正の掛からない拡散照度。
  await set('screenSpaceDiffuse', MODE.off);
  await save('off-diffuse');
  await target('normal');
  await save('normal');
  await target('depth');
  await save('depth');
  await target('off');
  writeFileSync(path.join(outDir, 'gpu.json'), JSON.stringify(gpu, null, 1));
  return gpu;
}

// ---- 復号 ----

// sRGB で符号化した 0..1 の値の線形の値。
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// PBR Neutral(three の neutralToneMapping、露出は掛けたあと)の順写像。
function neutral(c) {
  const x = Math.min(c[0], c[1], c[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  const shifted = c.map((v) => v - offset);
  const peak = Math.max(...shifted);
  if (peak < 0.76) return shifted;
  const d = 0.24;
  const newPeak = 1 - (d * d) / (peak + d - 0.76);
  const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return shifted.map((v) => v * (newPeak / peak) * (1 - g) + newPeak * g);
}

// PBR Neutral の逆写像。圧縮の掛からない範囲は閉じた式で、掛かる範囲は順写像を繰り返し当てて解く。
function inverseNeutral(t) {
  if (Math.max(...t) < 0.76) {
    const low = Math.min(...t);
    const x = low < 0.04 ? 0.4 * Math.sqrt(low) : low + 0.04;
    return t.map((v) => v + x - low);
  }
  let c = [...t];
  for (let i = 0; i < 100; i++) {
    const f = neutral(c);
    c = c.map((v, k) => v + (t[k] - f[k]));
  }
  return c;
}

// 8bit の PNG の画素ごとの RGB を、画素の値 code(0..255)から線形の値へ写す関数 decode で戻した Float32Array。
function decodeImage(png, decode) {
  const { width, height, channels, data } = decodePng(png);
  const rgb = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    rgb.set(decode([data[p * channels], data[p * channels + 1], data[p * channels + 2]]), p * 3);
  }
  return { width, height, rgb };
}

// 拡散照度などトーンマッピングして出す表示の画素の値を、線形の値へ。
const tonemappedValue = (code) => inverseNeutral(code.map((v) => srgbToLinear(v / 255)));
// 符号付きの補正の表示(0 が 127.5、成分ごとに符号と大きさ)の画素の値を、線形の値へ。
function signedValue(code) {
  const magnitude = inverseNeutral(code.map((v) => srgbToLinear(Math.abs(2 * v / 255 - 1))));
  return magnitude.map((m, k) => Math.sign(code[k] - 127.5) * m);
}

// 線形の RGB の並び rgb の、画素 p の輝度。
const luminance = (rgb, p) => 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2];

// ---- 指標 ----

// 窓 center の画素の添字。
function windowPixels(width, [cx, cy]) {
  const pixels = [];
  for (let y = cy - WINDOW_HALF; y <= cy + WINDOW_HALF; y++) {
    for (let x = cx - WINDOW_HALF; x <= cx + WINDOW_HALF; x++) pixels.push(y * width + x);
  }
  return pixels;
}

// values の平均。
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// 窓の偏り・RMS 誤差・誤差の標準偏差 [%](基準の窓の平均輝度に対する割合)。
function windowError(image, reference, center) {
  const pixels = windowPixels(image.width, center);
  const errors = pixels.map((p) => luminance(image.rgb, p) - luminance(reference.rgb, p));
  const scale = 100 / mean(pixels.map((p) => luminance(reference.rgb, p)));
  const bias = mean(errors);
  const rmse = Math.sqrt(mean(errors.map((e) => e * e)));
  const std = Math.sqrt(mean(errors.map((e) => (e - bias) ** 2)));
  return { bias: bias * scale, rmse: rmse * scale, std: std * scale };
}

// 法線の表示 normal と深度の表示 depth から、境界の画素の印。
function edgeMask(normal, depthPng) {
  const { width, height } = normal;
  const depth = decodePng(depthPng);
  const n = (p) => [0, 1, 2].map((k) => normal.rgb[p * 3 + k] * 2 - 1);
  const edges = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (const q of [x + 1 < width ? p + 1 : -1, y + 1 < height ? p + width : -1]) {
        if (q < 0) continue;
        const [a, b] = [n(p), n(q)];
        const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b);
        const depthStep = Math.abs(depth.data[p * depth.channels] - depth.data[q * depth.channels]);
        if (cos < EDGE_NORMAL_COS || depthStep >= EDGE_DEPTH_LSB) {
          edges[p] = 1;
          edges[q] = 1;
        }
      }
    }
  }
  return edges;
}

// 境界から EDGE_BAND 画素以内の面の印と、その外の面の印。面は方式オフの拡散照度が正の画素。
function bands(edges, surface, width, height) {
  const band = new Uint8Array(width * height);
  const interior = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!surface[p]) continue;
      let near = false;
      for (let dy = -EDGE_BAND; dy <= EDGE_BAND && !near; dy++) {
        for (let dx = -EDGE_BAND; dx <= EDGE_BAND && !near; dx++) {
          const [nx, ny] = [x + dx, y + dy];
          near = nx >= 0 && ny >= 0 && nx < width && ny < height && edges[ny * width + nx] === 1;
        }
      }
      (near ? band : interior)[p] = 1;
    }
  }
  return { band, interior };
}

// 接触影の断面 [足元からの距離 1..PROFILE_LENGTH の平均輝度]。足元は、start から toward へ進んで法線が start の面と
// 30° より離れた最初の画素の手前。
function contactProfile(image, normal, { start, toward }) {
  const { width } = image;
  const across = [-toward[1], toward[0]];
  const normalAt = (x, y) => [0, 1, 2].map((k) => normal.rgb[(y * width + x) * 3 + k] * 2 - 1);
  const profile = new Array(PROFILE_LENGTH).fill(0);
  for (let s = -PROFILE_HALF_WIDTH; s <= PROFILE_HALF_WIDTH; s++) {
    const [x0, y0] = [start[0] + across[0] * s, start[1] + across[1] * s];
    const floor = normalAt(x0, y0);
    let step = 0;
    for (; step < 200; step++) {
      const n = normalAt(x0 + toward[0] * (step + 1), y0 + toward[1] * (step + 1));
      const cos = (n[0] * floor[0] + n[1] * floor[1] + n[2] * floor[2]) / Math.hypot(...n) / Math.hypot(...floor);
      if (cos < EDGE_NORMAL_COS) break;
    }
    for (let d = 1; d <= PROFILE_LENGTH; d++) {
      const [x, y] = [x0 + toward[0] * (step + 1 - d), y0 + toward[1] * (step + 1 - d)];
      profile[d - 1] += luminance(image.rgb, y * width + x) / (2 * PROFILE_HALF_WIDTH + 1);
    }
  }
  return profile;
}

// 断面の足元の暗さと、その半分まで戻る距離 [px]。
function contactShadow(profile) {
  const range = ([from, to]) => mean(profile.slice(from - 1, to));
  const near = range(PROFILE_NEAR);
  const far = range(PROFILE_FAR);
  const half = near + (far - near) / 2;
  let spread = PROFILE_LENGTH;
  for (let d = PROFILE_NEAR[0]; d < PROFILE_LENGTH; d++) {
    const [a, b] = [profile[d - 1], profile[d]];
    if ((a - half) * (b - half) <= 0 && a !== b) {
      spread = d + (half - a) / (b - a);
      break;
    }
  }
  return { contrast: 1 - near / far, spread };
}

// 窓 center の、image から base を引いた RGB の平均の和。
function windowDifference(image, base, center) {
  const pixels = windowPixels(image.width, center);
  return mean(pixels.map((p) => [0, 1, 2].reduce((sum, k) => sum + image.rgb[p * 3 + k] - base.rgb[p * 3 + k], 0)));
}

// 印 mask の画素の、image と reference の輝度の RMS 誤差 [%](基準の平均輝度に対する割合)。
function maskedError(image, reference, mask) {
  let squared = 0;
  let scale = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    squared += (luminance(image.rgb, p) - luminance(reference.rgb, p)) ** 2;
    scale += luminance(reference.rgb, p);
    count++;
  }
  return 100 * Math.sqrt(squared / count) / (scale / count);
}

// 連続するフレーム frames の、印 mask の画素の輝度の平均絶対差 [%](平均輝度に対する割合)の平均。
function frameDifference(frames, mask) {
  const differences = [];
  for (let k = 1; k < frames.length; k++) {
    let sum = 0;
    let scale = 0;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      sum += Math.abs(luminance(frames[k].rgb, p) - luminance(frames[k - 1].rgb, p));
      scale += luminance(frames[k - 1].rgb, p);
    }
    differences.push(100 * sum / scale);
  }
  return mean(differences);
}

// 方式オフの拡散照度の表示 offPng と、補正の表示 correctionPng から、和が負になる画素の数。量子化の幅(画素の値 ±½)の
// どこを取っても負なものと、負を取りうるもの。
function negativePixels(offPng, correctionPng) {
  const off = decodePng(offPng);
  const correction = decodePng(correctionPng);
  const at = (png, p, bias) => [0, 1, 2].map((k) => Math.min(255, Math.max(0, png.data[p * png.channels + k] + bias)));
  let certain = 0;
  let possible = 0;
  for (let p = 0; p < off.width * off.height; p++) {
    if (Math.max(...at(off, p, 0)) === 0) continue;
    const highest = tonemappedValue(at(off, p, 0.5)).map((v, k) => v + signedValue(at(correction, p, 0.5))[k]);
    const lowest = tonemappedValue(at(off, p, -0.5)).map((v, k) => v + signedValue(at(correction, p, -0.5))[k]);
    if (highest.some((v) => v < 0)) certain++;
    else if (lowest.some((v) => v < 0)) possible++;
  }
  return { certain, possible };
}

// ---- 表 ----

// 小数 digits 桁の文字列。null と NaN(測れなかった値)は —。
const fixed = (value, digits) => (value === null || Number.isNaN(value) ? '—' : value.toFixed(digits));

// outDir の組を referenceDir の組の基準の段と比べ、表を出す。
function report(outDir, referenceDir, gpu) {
  const load = (dir, name, decode) => decodeImage(readFileSync(path.join(dir, `${name}.png`)), decode);
  const readPng = (dir, name) => readFileSync(path.join(dir, `${name}.png`));
  const normal = load(outDir, 'normal', (code) => code.map((v) => srgbToLinear(v / 255)));
  const off = load(outDir, 'off-diffuse', tonemappedValue);
  const { width, height } = off;
  const surface = Uint8Array.from({ length: width * height }, (_, p) => (luminance(off.rgb, p) > 0 ? 1 : 0));
  const { band, interior } = bands(edgeMask(normal, readPng(outDir, 'depth')), surface, width, height);
  const reference = load(referenceDir, `q${REFERENCE_QUALITY}-diffuse`, tonemappedValue);
  const referenceOcclusion = load(referenceDir, `q${REFERENCE_QUALITY}-occlusion-diffuse`, tonemappedValue);
  const referenceContact = Object.fromEntries(Object.entries(PROFILES)
    .map(([name, profile]) => [name, contactShadow(contactProfile(reference, normal, profile))]));
  const referenceBounce = Object.fromEntries(BOUNCE_WINDOWS
    .map((name) => [name, windowDifference(reference, referenceOcclusion, WINDOWS[name])]));

  const windowNames = Object.keys(WINDOWS);
  const header = [
    '段',
    ...['偏り', 'RMS', '標準偏差'].map((metric) => `窓の${metric} [%] ${windowNames.join(' / ')}`),
    ...Object.keys(PROFILES).map((name) => `接触影 ${name} 暗さの差 / 距離の差 [px]`),
    `照り返し / 基準 ${BOUNCE_WINDOWS.join(' / ')}`,
    '境界の漏れ [%]',
    '連続フレーム差 [%]',
    '負の画素 確か / ありうる',
    'GPU 復元 / マテリアル [ms]',
  ];
  console.log(`\n基準: ${path.relative(root, referenceDir) || '.'} の段 ${REFERENCE_QUALITY}`);
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${' --- |'.repeat(header.length)}`);
  for (const { label, value: q } of QUALITIES) {
    const image = load(outDir, `q${q}-diffuse`, tonemappedValue);
    const occlusion = load(outDir, `q${q}-occlusion-diffuse`, tonemappedValue);
    const errors = windowNames.map((name) => windowError(image, reference, WINDOWS[name]));
    const contact = Object.entries(PROFILES).map(([name, profile]) => {
      const shadow = contactShadow(contactProfile(image, normal, profile));
      const base = referenceContact[name];
      return `${fixed(shadow.contrast - base.contrast, 3)} / ${fixed(shadow.spread - base.spread, 1)}`;
    });
    const bounce = BOUNCE_WINDOWS
      .map((name) => fixed(windowDifference(image, occlusion, WINDOWS[name]) / referenceBounce[name], 3));
    const dolly = Array.from({ length: DOLLY_FRAMES }, (_, k) => load(outDir, `q${q}-dolly-${k + 1}`, tonemappedValue));
    const frames = [image, ...dolly];
    let negatives = '—';
    try {
      const { certain, possible } = negativePixels(readPng(outDir, 'off-diffuse'), readPng(outDir, `q${q}-correction`));
      negatives = `${certain} / ${possible}`;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const cells = [
      label,
      ...['bias', 'rmse', 'std'].map((metric) => errors.map((e) => fixed(e[metric], 2)).join(' / ')),
      ...contact,
      bounce.join(' / '),
      fixed(maskedError(image, reference, band), 2),
      fixed(frameDifference(frames, interior), 3),
      negatives,
      `${fixed(gpu[q]?.['近傍拡散復元'] ?? null, 3)} / ${fixed(gpu[q]?.['マテリアル'] ?? null, 3)}`,
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
  const shadows = Object.entries(referenceContact)
    .map(([name, { contrast, spread }]) => `${name} 暗さ ${fixed(contrast, 3)} 距離 ${fixed(spread, 1)} px`);
  console.log(`\n基準の接触影: ${shadows.join('、')}`);
}

async function main() {
  const [outArg, referenceArg] = process.argv.slice(2);
  if (outArg === undefined) throw new Error(USAGE);
  const outDir = path.resolve(root, outArg);
  const referenceDir = referenceArg === undefined ? outDir : path.resolve(root, referenceArg);
  mkdirSync(outDir, { recursive: true });

  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-render-lab-ss-',
  });
  let gpu;
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.measure === 'function')",
      'the render lab to initialise');
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    gpu = await captureSet(devTools, outDir);
  } finally {
    await session.close();
  }
  report(outDir, referenceDir, gpu);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
