// 夕景(低仰角の太陽)の見た目の基準採取。自己完結で、webpack の本番ビルド(.render-lab)から始め、
// headless Chrome で render-lab の 'earth' ケースを駆動して (A) 太陽仰角の掃引の絵、
// (B) 雲の画素の照明項の分解、(C) モンタージュを .cloud-lab/sunset-look/<tag>/ へ書く。
//   使い方: node tools/sunset-look.mjs — 引数は無し。動作の切り替えは
//   作業ツリー直下の .loop-sunset-look-config.json(任意)で行う:
//     { "tag": "base",   // 出力先 .cloud-lab/sunset-look/<tag>/ の名前
//       "build": true }  // false なら webpack を飛ばして既存の .render-lab/ を使う
// 仰角は直下点の水平面での太陽の仰角 [deg](tools/sunset-sweep-check.mjs と同じ取り決め)。
// 視点は3系統: 海抜20m('surface')・2km('air')・400km 斜視('orbit')。方位は直下点で
// 太陽が視線側(az30='sun')か背後(az210='away')かの2つ。分解は orbit の sun 側で撮る。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openChromeSession, sleep, waitFor, collectFatalEvents } from './chrome-session.mjs';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
// 他の計測(sunset-sweep 8779/9458、cloud-shadow-check 8775/9454)と衝突しない固定ポート。
const PORT = 8781;
const DEBUG_PORT = 9460;

const configPath = path.join(root, '.loop-sunset-look-config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const tag = config.tag ?? 'base';
const outRoot = path.join(root, '.cloud-lab', 'sunset-look', tag);

const R_EARTH = 6.371e6;
// 高度 altitude [m] の視点から地平線が視線より margin [rad] 上へ来る地球の置き方
// (tools/render-lab/earth-cases.ts の placementBelowHorizon と同じ形)。
// margin > 0 → 地平線は視線より下へ行く(空を多く見せる)。直下点は大西洋の貿易風帯。
const placementBelowHorizon = (altitudeM, margin) => ({
  earthAzimuthDeg: 180,
  earthElevationDeg: -(Math.asin(R_EARTH / (R_EARTH + altitudeM)) + margin) * 180 / Math.PI,
  earthAltitudeLog: Math.log10(altitudeM),
  earthLatitudeDeg: 15,
  earthLongitudeDeg: -35,
});

// 視点3系統。surface は海抜 20m で地平線を少し下げて空を多めに、air は 2km で地平線を中央へ、
// orbit は 400km 斜視で地平線を視線より上げて昼夜境界と大気の縁を両方入れる。
const VIEWS = [
  { name: 'surface', view: placementBelowHorizon(20, 0.06) },
  { name: 'air', view: placementBelowHorizon(2e3, 0) },
  { name: 'orbit', view: placementBelowHorizon(400e3, -0.20) },
];

// 掃引する直下点の太陽仰角 [deg]。地平線の上下へ細かく取る。
const SWEEP_ELEVATIONS_DEG = [20, 10, 5, 3, 2, 1, 0.5, 0, -1, -2, -3, -4, -6];
// 分解を撮る仰角。掃引のうちの代表。
const DECOMP_ELEVATIONS_DEG = [20, 10, 5, 3, 2, 1, 0, -2, -4];
// 直下点の水平面で太陽が視線側へ来る方位と背後へ来る方位(北=0・東=90)。
// この置き方では直下点の北はほぼ -Z(カメラの視線)なので、30 は「太陽側を向く」、210 は「背中側」。
const AZIMUTHS = [
  { name: 'sun', deg: 30 },
  { name: 'away', deg: 210 },
];
// 分解を撮る視点(雲が写る斜視)と方位。
const DECOMP_VIEW = 'orbit';
const DECOMP_AZIMUTH = 30;
// 画素の標本を取る窓の半径 [px]。7×7 の平均。
const SAMPLE_RADIUS = 3;

// 描画原点の直下点での描画座標の東・北・上(tools/render-lab/lab-earth.ts の earthSpinOf と
// 同じ組み方 — 上は地球の中心から描画原点への向き、北は仰角を上げる向き、東は 北×上)。
function localFrameOf(view) {
  const az = view.earthAzimuthDeg * Math.PI / 180;
  const el = view.earthElevationDeg * Math.PI / 180;
  const up = [-Math.sin(az) * Math.cos(el), -Math.sin(el), -Math.cos(az) * Math.cos(el)];
  const north = [-Math.sin(az) * Math.sin(el), Math.cos(el), -Math.cos(az) * Math.sin(el)];
  const east = [
    north[1] * up[2] - north[2] * up[1],
    north[2] * up[0] - north[0] * up[2],
    north[0] * up[1] - north[1] * up[0],
  ];
  return { east, north, up };
}

// 直下点の水平面で方位 azimuthDeg・仰角 elevationDeg の太陽へ、観察のつまみの方位・仰角を答える。
// sunset-sweep-check.mjs の取り決めと同じ: 仰角は直下点での太陽の高さで、描画原点のつまみ
// sunElevationDeg ではない。
function sceneSunAngles(azimuthDeg, elevationDeg, frame) {
  const az = azimuthDeg * Math.PI / 180;
  const el = elevationDeg * Math.PI / 180;
  const h = Math.cos(el);
  const d = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    d[i] = frame.east[i] * Math.sin(az) * h
      + frame.north[i] * Math.cos(az) * h
      + frame.up[i] * Math.sin(el);
  }
  const length = Math.hypot(d[0], d[1], d[2]);
  return {
    sunAzimuthDeg: Math.atan2(d[0], d[2]) * 180 / Math.PI,
    sunElevationDeg: Math.asin(Math.min(1, Math.max(-1, d[1] / length))) * 180 / Math.PI,
  };
}

// 評価で固定する描画品質設定(高プリセットの雲まわり。cloud-shadow-check.mjs と同じ)に、
// 分解で動かす光源の項(環境光・エアグロー・天体照の数)の基準値を足したもの。
const GRAPHICS = [
  ['clouds', true], ['cloudFieldSource', 'generated'], ['cirrus', true],
  ['cumulusDetail', 2], ['cirrusDetail', 1], ['cloudShadow', true],
  ['atmosphere', 3], ['sunLightModel', 1],
  ['ambient', true], ['airglow', true], ['planetLightCount', 2],
];

function buildRenderLab() {
  const cli = path.join(root, 'node_modules', 'webpack-cli', 'bin', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, '--config', 'webpack.render-lab.config.js', '--mode', 'production'],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (code) => (
      code === 0 ? resolve() : reject(new Error(`webpack exited with code ${code}`))
    ));
    child.on('error', reject);
  });
}

// 絵が落ち着くまで撮り直す(連続 2 回の一致で判定)。
async function captureSettled(evaluate, label) {
  let previous = await evaluate('window.renderLab.capture()');
  for (let count = 0; count < 6; count++) {
    await sleep(150);
    const next = await evaluate('window.renderLab.capture()');
    if (next === previous) return next;
    previous = next;
  }
  throw new Error(`${label}: capture did not settle`);
}

const dataUrlToPng = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

// sRGB 8bit → 線形(逆ガンマだけ)。
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
// 線形 → sRGB 8bit(負は 0 へ切る)。差分の可視化に使う。
const srgb8 = (v) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
};

// 仰角 → ファイル名の断片(負号と小数点をファイル名安全な字へ)。
const elevToken = (elev) => `e${String(elev).replace('-', 'm').replace('.', 'p')}`;

// 雲あり画像と雲なし画像から、「雲ありのほうが雲なしより明るい画素」の一覧を返す
// (sunset-sweep-check.mjs の analyze と同じ判定 — 海より明るい雲頂を拾い、雲影は拾わない)。
function cloudPixels(cloudPng, clearPng) {
  const { width, height, channels, data: on } = cloudPng;
  const { data: off } = clearPng;
  const pixels = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const lumOn = 0.2126 * lin(on[o]) + 0.7152 * lin(on[o + 1]) + 0.0722 * lin(on[o + 2]);
    const lumOff = 0.2126 * lin(off[o]) + 0.7152 * lin(off[o + 1]) + 0.0722 * lin(off[o + 2]);
    if (lumOn > 0.002 && lumOn > lumOff * 1.15) pixels.push({ i, lum: lumOn });
  }
  return pixels;
}

// 雲の画素から代表の1点を選ぶ。明るさの中央値の画素 — 最も輝く雲頂でも縁の薄い画素でもない、
// その絵の「普通の雲」が見本として欲しい。
function representativePixel(pixels) {
  if (pixels.length === 0) return null;
  const sorted = [...pixels].sort((a, b) => a.lum - b.lum);
  return sorted[Math.floor(sorted.length / 2)];
}

// RGB(線形)の色相角 [deg]。彩度 0 では 0。
function hueDeg(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// decoded PNG の画素 i を中心とする (2r+1)^2 窓の線形 RGB の平均とその色相。
function sampleWindow(png, pixelIndex, r = SAMPLE_RADIUS) {
  const { width, height, channels, data } = png;
  const cx = pixelIndex % width;
  const cy = Math.floor(pixelIndex / width);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const o = (y * width + x) * channels;
      sr += lin(data[o]); sg += lin(data[o + 1]); sb += lin(data[o + 2]);
      n++;
    }
  }
  const rgb = [sr / n, sg / n, sb / n];
  return { rgb, hue: hueDeg(...rgb) };
}

// 線形の差分画像(負もあり)を、sRGB の RGB PNG 画素列へ。負は 0 に切る。
function diffToRgbBytes(diff, count) {
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = srgb8(diff[i * 3]);
    rgb[i * 3 + 1] = srgb8(diff[i * 3 + 1]);
    rgb[i * 3 + 2] = srgb8(diff[i * 3 + 2]);
  }
  return rgb;
}

// 2 枚の PNG の線形化した差分 a − b を画素ごとに取る。
function linearDiff(aPng, bPng) {
  const { width, height, channels, data: a } = aPng;
  const { data: b } = bPng;
  const diff = new Float64Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    diff[i * 3] = lin(a[o]) - lin(b[o]);
    diff[i * 3 + 1] = lin(a[o + 1]) - lin(b[o + 1]);
    diff[i * 3 + 2] = lin(a[o + 2]) - lin(b[o + 2]);
  }
  return diff;
}

// 差分画像の画素 i を中心とする窓の平均と色相。
function sampleDiffWindow(diff, width, height, pixelIndex, r = SAMPLE_RADIUS) {
  const cx = pixelIndex % width;
  const cy = Math.floor(pixelIndex / width);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const o = (y * width + x) * 3;
      sr += diff[o]; sg += diff[o + 1]; sb += diff[o + 2];
      n++;
    }
  }
  const rgb = [sr / n, sg / n, sb / n];
  return { rgb, hue: hueDeg(...rgb) };
}

// decoded PNG(RGB/RGBA)を w×h へ双一次で縮めた RGB 画素列。
function downscale(png, w, h) {
  const { width, height, channels, data } = png;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const py = (y + 0.5) * (height / h) - 0.5;
    const y0 = Math.max(0, Math.floor(py));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, py - y0));
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5) * (width / w) - 0.5;
      const x0 = Math.max(0, Math.floor(px));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, px - x0));
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = data[(y0 * width + x0) * channels + c] * (1 - fx) * (1 - fy)
          + data[(y0 * width + x1) * channels + c] * fx * (1 - fy)
          + data[(y1 * width + x0) * channels + c] * (1 - fx) * fy
          + data[(y1 * width + x1) * channels + c] * fx * fy;
        out[o + c] = Math.round(v);
      }
    }
  }
  return out;
}

// RGB 画素列のタイルを格子へ並べたモンタージュの RGB 画素列。余白は黒。
// tiles は [{ rgb, width, height }]、同じ寸法のものだけを並べる。
function montage(tiles, cols, tileW, tileH) {
  const rows = Math.ceil(tiles.length / cols);
  const w = cols * tileW;
  const h = rows * tileH;
  const out = new Uint8Array(w * h * 3);
  tiles.forEach((tile, index) => {
    const ox = (index % cols) * tileW;
    const oy = Math.floor(index / cols) * tileH;
    for (let y = 0; y < tileH; y++) {
      out.set(
        tile.rgb.subarray(y * tileW * 3, (y + 1) * tileW * 3),
        ((oy + y) * w + ox) * 3,
      );
    }
  });
  return { width: w, height: h, rgb: out };
}

async function main() {
  if (config.build !== false || !existsSync(path.join(buildDir, 'index.html'))) {
    console.log('=== webpack --config webpack.render-lab.config.js --mode production ===');
    await buildRenderLab();
  }
  mkdirSync(outRoot, { recursive: true });
  const { onEvent, fatalEvents } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port: PORT, debugPort: DEBUG_PORT,
    profilePrefix: 'tepui-sunset-look-', onEvent,
    requestTimeoutMs: 120_000,
  });
  const decomposition = [];
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools, 'typeof window.renderLab?.capture === "function"', 'renderLab API');
    const evaluate = devTools.evaluate.bind(devTools);
    const setG = (key, value) => evaluate(
      `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    const restoreBaseline = async () => {
      await evaluate(`window.renderLab.setTarget('off')`);
      for (const [key, value] of GRAPHICS) await setG(key, value);
    };
    for (const [key, value] of GRAPHICS) await setG(key, value);
    await evaluate(`window.renderLab.show('earth')`);
    const shoot = (label) => captureSettled(evaluate, label).then(dataUrlToPng);

    // (A) 太陽仰角の掃引。視点×方位×仰角の全組で通常合成を撮る。
    for (const camera of VIEWS) {
      const frame = localFrameOf(camera.view);
      for (const { name: azName, deg: azDeg } of AZIMUTHS) {
        for (const elev of SWEEP_ELEVATIONS_DEG) {
          const view = { ...camera.view, ...sceneSunAngles(azDeg, elev, frame) };
          await evaluate(`window.renderLab.setView(${JSON.stringify(view)})`);
          await evaluate('window.renderLab.setDisplayTime(0)');
          const png = await shoot(`${camera.name} ${azName} el${elev}`);
          writeFileSync(path.join(outRoot, `${elevToken(elev)}_${camera.name}_${azName}.png`), png);
          console.log(`sweep ${camera.name} ${azName} el=${elev}`);
        }
      }
    }

    // (B) 照明項の分解。orbit 視点の sun 側で、仰角ごとに
    //   all:      通常合成(全項)
    //   direct:   'material' デバッグ表示 + ambient off + 天体照 0(不透明物の直射だけ)
    //   ambient:  'material' 表示で ambient on − off の線形差分
    //   inscatter:'atmosphere' デバッグ表示 + エアグロー off
    // を撮り、雲の代表画素の線形 RGB と色相を記録する。
    const decompView = VIEWS.find((v) => v.name === DECOMP_VIEW);
    const decompFrame = localFrameOf(decompView.view);
    for (const elev of DECOMP_ELEVATIONS_DEG) {
      const view = { ...decompView.view, ...sceneSunAngles(DECOMP_AZIMUTH, elev, decompFrame) };
      await evaluate(`window.renderLab.setView(${JSON.stringify(view)})`);
      await evaluate('window.renderLab.setDisplayTime(0)');
      const stem = `${elevToken(elev)}_${decompView.name}`;
      await restoreBaseline();
      const allPng = await shoot(`${stem} all`);
      writeFileSync(path.join(outRoot, `${stem}_all.png`), allPng);
      const allDecoded = decodePng(allPng);
      const { width, height } = allDecoded;
      await setG('clouds', false);
      const clearPng = await shoot(`${stem} clear`);
      writeFileSync(path.join(outRoot, `${stem}_clear.png`), clearPng);
      const clearDecoded = decodePng(clearPng);
      await setG('clouds', true);
      // 'material' 表示の直射(ambient off・天体照 0)と環境光の差分。
      await evaluate(`window.renderLab.setTarget('material')`);
      await setG('ambient', false);
      await setG('planetLightCount', 0);
      const directPng = await shoot(`${stem} direct`);
      writeFileSync(path.join(outRoot, `${stem}_direct.png`), directPng);
      const directDecoded = decodePng(directPng);
      await setG('ambient', true);
      const ambOnPng = await shoot(`${stem} ambient-on`);
      const ambientDiff = linearDiff(decodePng(ambOnPng), directDecoded);
      writeFileSync(
        path.join(outRoot, `${stem}_ambient.png`),
        encodeRgbPng(width, height, diffToRgbBytes(ambientDiff, width * height)),
      );
      // 'atmosphere' 表示の大気項(エアグロー抜き)。
      await setG('ambient', false);
      await setG('airglow', false);
      await evaluate(`window.renderLab.setTarget('atmosphere')`);
      const inscatterPng = await shoot(`${stem} inscatter`);
      writeFileSync(path.join(outRoot, `${stem}_inscatter.png`), inscatterPng);
      await restoreBaseline();

      // 雲の代表画素(雲あり − 雲なしの明るい差)と各項の標本。
      const pixels = cloudPixels(allDecoded, clearDecoded);
      const rep = representativePixel(pixels);
      if (rep === null) {
        console.log(`decomp el=${elev}: 雲の画素が無い`);
        decomposition.push({ elevationDeg: elev, cloudPixelCount: 0, pixel: null, terms: null });
        continue;
      }
      const terms = {
        all: sampleWindow(allDecoded, rep.i),
        direct: sampleWindow(directDecoded, rep.i),
        ambient: sampleDiffWindow(ambientDiff, width, height, rep.i),
        inscatter: sampleWindow(decodePng(inscatterPng), rep.i),
      };
      decomposition.push({
        elevationDeg: elev,
        cloudPixelCount: pixels.length,
        pixel: { x: rep.i % width, y: Math.floor(rep.i / width) },
        terms,
      });
      const f = (t) => `(${t.rgb.map((v) => v.toFixed(5)).join(',')}) h=${t.hue.toFixed(1)}`;
      console.log(
        `decomp el=${String(elev).padStart(4)} n=${String(pixels.length).padStart(6)}`
        + ` all=${f(terms.all)} direct=${f(terms.direct)}`
        + ` ambient=${f(terms.ambient)} inscatter=${f(terms.inscatter)}`,
      );
    }
  } finally {
    await session.close();
  }
  writeFileSync(
    path.join(outRoot, 'decomposition.json'),
    `${JSON.stringify(decomposition, null, 2)}\n`,
  );

  // (C) モンタージュ。書き出した PNG を読み直して 480×270 のタイルへ縮め、
  // 仰角順(リストの並び)に左→右・上→下で並べる。
  const tile = (file) => downscale(decodePng(readFileSync(path.join(outRoot, file))), 480, 270);
  const sheets = [
    // 掃引: 視点×方位ごと。
    ...VIEWS.flatMap((camera) => AZIMUTHS.map(({ name: azName }) => ({
      name: `sheet-${camera.name}-${azName}.png`,
      files: SWEEP_ELEVATIONS_DEG.map((elev) => `${elevToken(elev)}_${camera.name}_${azName}.png`),
    }))),
    // 分解: 項ごと(orbit 視点)。
    ...['all', 'direct', 'ambient', 'inscatter'].map((term) => ({
      name: `sheet-decomposition-${term}.png`,
      files: DECOMP_ELEVATIONS_DEG.map(
        (elev) => `${elevToken(elev)}_${DECOMP_VIEW}_${term}.png`),
    })),
  ];
  for (const sheet of sheets) {
    const tiles = sheet.files.filter((f) => existsSync(path.join(outRoot, f)))
      .map((f) => ({ rgb: tile(f), width: 480, height: 270 }));
    if (tiles.length === 0) continue;
    const grid = montage(tiles, 5, 480, 270);
    writeFileSync(path.join(outRoot, sheet.name), encodeRgbPng(grid.width, grid.height, grid.rgb));
    console.log(`sheet ${sheet.name} (${tiles.length} tiles)`);
  }
  if (fatalEvents.length > 0) {
    console.error('fatal page events:', fatalEvents);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
