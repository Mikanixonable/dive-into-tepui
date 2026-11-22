// 直射日光の大気減衰を仰角の掃引で測る道具。自己完結で、render-lab の本番ビルド(.render-lab)
// から始め、headless Chrome で「雲あり」「雲なし」の同じ視点の 2 枚を仰角ごとに撮り、
// 雲の画素の線形輝度の統計(平均・99% 点・最大・R/B 比)と地表の輝度を出す。
//   使い方: node tools/sunset-sweep-check.mjs — 引数は無し。動作の切り替えは
//   作業ツリー直下の .loop-sunset-config.json(任意)で行う:
//     { "tag": "base",   // 出力先 .cloud-lab/sunset/<tag>/ の名前
//       "build": true }  // false なら webpack を飛ばして既存の .render-lab/ を使う
// 出力は標準出力の表と .cloud-lab/sunset/<tag>/ 以下の撮影 PNG・metrics.json。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openChromeSession, sleep, waitFor, collectFatalEvents } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
// 他の計測(render-lab-shot 8767/9444、cloud-shadow-check 8775/9454)と衝突しない固定ポート。
const PORT = 8779;
const DEBUG_PORT = 9458;

const configPath = path.join(root, '.loop-sunset-config.json');
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const tag = config.tag ?? 'base';
const outRoot = path.join(root, '.cloud-lab', 'sunset', tag);

const R_EARTH = 6.371e6;
// 高度 altitude [m] の視点から地平線が視線より margin [rad] 上へ来る地球の置き方
// (tools/render-lab/earth-cases.ts の placementBelowHorizon と同じ形)。
const placementBelowHorizon = (altitudeM, margin) => ({
  earthAzimuthDeg: 180,
  earthElevationDeg: -(Math.asin(R_EARTH / (R_EARTH + altitudeM)) + margin) * 180 / Math.PI,
  earthAltitudeLog: Math.log10(altitudeM),
  // 直下点は大西洋の貿易風帯(北緯 15°・西経 35°)。
  earthLatitudeDeg: 15,
  earthLongitudeDeg: -35,
});

// 直下点の太陽の仰角 [deg]。地平線の上下へ細かく取る。観察のつまみ sunElevationDeg は
// 描画原点の水平面での仰角で直下点の仰角ではないので、置いた角度から局所の向きへ直して渡す。
const ELEVATIONS_DEG = [40, 20, 10, 5, 3, 2, 1, 0.5, 0, -1, -2, -3];
// カメラの見る向きへ斜めに当たる方位と、背中側から当たる方位(直下点の水平面で、北=0・東=90)。
const AZIMUTHS_DEG = [30, 210];
// 直下から約 200km の斜め見下ろしと、約 60km の近い見下ろし(積雲の縁が画素で見える尺度)。
const CAMERAS = [
  { name: 'oblique', view: placementBelowHorizon(200e3, -0.49) },
  { name: 'low', view: placementBelowHorizon(60e3, -0.49) },
];

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

// 評価で固定する描画品質設定(高プリセットの雲まわり。cloud-shadow-check.mjs と同じ)。
const GRAPHICS = [
  ['clouds', true], ['cloudFieldSource', 'generated'], ['cirrus', true],
  ['cumulusMarchSteps', 6], ['cumulusRefineSteps', 3], ['cumulusOctaves', 6], ['cirrusDetail', 1], ['cloudShadow', true],
  ['atmosphere', true], ['atmosphereSampleBudget', 24], ['sunLightModel', 1],
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

// sRGB 8bit → 線形(逆ガンマだけ。比較はこの道具どうしで行う)。
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// 雲あり画像と雲なし画像から、雲の画素の統計と地表(雲なし画像)の輝度を出す。
// 雲の画素は「雲ありのほうが雲なしより明るい画素」— 海より明るい雲頂を拾い、暗い側へ
// 落ちる雲影は拾わない。
function analyze(cloudPng, clearPng) {
  const { width, height, channels, data: on } = cloudPng;
  const { data: off } = clearPng;
  const cloudLum = [];
  const groundLum = [];
  let sumR = 0;
  let sumB = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const rOn = lin(on[o]);
    const gOn = lin(on[o + 1]);
    const bOn = lin(on[o + 2]);
    const lumOn = 0.2126 * rOn + 0.7152 * gOn + 0.0722 * bOn;
    const lumOff = 0.2126 * lin(off[o]) + 0.7152 * lin(off[o + 1]) + 0.0722 * lin(off[o + 2]);
    groundLum.push(lumOff);
    if (lumOn > 0.002 && lumOn > lumOff * 1.15) {
      cloudLum.push(lumOn);
      sumR += rOn;
      sumB += bOn;
    }
  }
  cloudLum.sort((a, b) => a - b);
  const mean = (values) => values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  return {
    cloudPixelCount: cloudLum.length,
    cloudMean: mean(cloudLum),
    cloudP99: cloudLum.length === 0 ? 0 : cloudLum[Math.floor(cloudLum.length * 0.99)],
    cloudMax: cloudLum.length === 0 ? 0 : cloudLum[cloudLum.length - 1],
    cloudRB: sumB > 0 ? sumR / sumB : 0,
    groundMean: mean(groundLum),
  };
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
    profilePrefix: 'tepui-sunset-sweep-', onEvent,
    requestTimeoutMs: 120_000,
  });
  const metrics = [];
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools, 'typeof window.renderLab?.capture === "function"', 'renderLab API');
    for (const [key, value] of GRAPHICS) {
      await devTools.evaluate(
        `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
    }
    await devTools.evaluate(`window.renderLab.show('earth')`);
    const evaluate = devTools.evaluate.bind(devTools);
    const setG = (key, value) => evaluate(
      `window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);

    for (const camera of CAMERAS) {
      const frame = localFrameOf(camera.view);
      for (const azimuthDeg of AZIMUTHS_DEG) {
        for (const elevationDeg of ELEVATIONS_DEG) {
          const view = {
            ...camera.view,
            ...sceneSunAngles(azimuthDeg, elevationDeg, frame),
          };
          const stem = `${camera.name}-az${azimuthDeg}-el${elevationDeg}`;
          await evaluate(`window.renderLab.setView(${JSON.stringify(view)})`);
          await evaluate('window.renderLab.setDisplayTime(0)');
          await setG('clouds', true);
          const cloudShot = await captureSettled(evaluate, `${stem} cloud`);
          await setG('clouds', false);
          const clearShot = await captureSettled(evaluate, `${stem} clear`);
          const cloudPath = path.join(outRoot, `${stem}-cloud.png`);
          const clearPath = path.join(outRoot, `${stem}-clear.png`);
          writeFileSync(cloudPath, dataUrlToPng(cloudShot));
          writeFileSync(clearPath, dataUrlToPng(clearShot));
          const result = analyze(decodePng(dataUrlToPng(cloudShot)), decodePng(dataUrlToPng(clearShot)));
          metrics.push({ camera: camera.name, azimuthDeg, elevationDeg, ...result });
          console.log(
            `${camera.name} az=${String(azimuthDeg).padStart(3)} el=${String(elevationDeg).padStart(4)}`
            + ` n=${String(result.cloudPixelCount).padStart(6)} mean=${result.cloudMean.toFixed(5)}`
            + ` p99=${result.cloudP99.toFixed(5)} R/B=${result.cloudRB.toFixed(3)}`
            + ` ground=${result.groundMean.toFixed(5)}`,
          );
        }
      }
    }
  } finally {
    await session.close();
  }
  writeFileSync(path.join(outRoot, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  if (fatalEvents.length > 0) {
    console.error('fatal page events:', fatalEvents);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
