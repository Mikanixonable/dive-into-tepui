// 雲の描画経路の多スケール撮影。ヘッドレス Chrome で .cloud-lab/render-capture.html を開き、
// 地域 cap × 高度と全球の 1 枚を、render-lab と同じ描画経路で撮る。時刻・太陽・画角・解像度は
// 固定し、落ち着くまで撮り直して決定的な絵だけを .cloud-lab/render-capture/ へ残す。
// 部分指定: --regions=npac-storm,usec --ladders=400 のように絞ると、その枠だけ撮り、
// manifest にはその枠だけを残す (compare は無い対を飛ばすので、部分行列の測定になる)。
// 部分指定時は出力先を作り直さない — 他の枠の PNG は残るが manifest からは外れる。
// フル行列に戻すときは、引数無しで全枠を撮り直す (出力先を作り直す)。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'render-capture');
const port = 8770;
const debugPort = 9447;

// 撮る地域。cloud-lab:compare の REGIONS と同じ直下点。
const REGIONS = [
  { name: 'npac-storm', latitude: 45, longitude: -170 },
  { name: 'natl-storm', latitude: 50, longitude: -30 },
  { name: 'so-ocean', latitude: -55, longitude: 100 },
  { name: 'sepac-subtrop', latitude: -20, longitude: -85 },
  { name: 'sahara', latitude: 22, longitude: 10 },
  { name: 'itcz-atl', latitude: 5, longitude: -25 },
  { name: 'typhoon', latitude: 19, longitude: 136 },
];
// 直下視の高度 [km]。
const ALTITUDES_KM = [400, 2000, 10000];
// 地球の平均半径 [km]。
const R_EARTH_KM = 6371;
// 全球: 円盤の視半径が FOV 半角の 80% になるカメラ距離 [km] (極の撮影と同じ式)。
const FOV_DEG = 50;
function degToRad(deg) { return (deg * Math.PI) / 180; }
const GLOBE_CAMERA_KM = R_EARTH_KM / Math.sin(degToRad(FOV_DEG / 2) * 0.8) - R_EARTH_KM;
// 太陽: 直下点の天頂から東へ 30°。全地域で同じ太陽幾何にする。
const SUN_AZIMUTH_DEG = 30;
const SUN_ELEVATION_DEG = 0;
// 撮る表示時刻 [h]。
const DISPLAY_HOURS = 0;
// 画面の高さ [px]。render-lab の LabView と対。
const VIEW_HEIGHT = 540;

// 直下点での 1 画素あたりの地上距離 [km/px]。
function kmPerPx(cameraDistanceKm) {
  return (2 * cameraDistanceKm * Math.tan(degToRad(FOV_DEG / 2))) / VIEW_HEIGHT;
}

const CAPTURES = [
  ...REGIONS.flatMap((region) => ALTITUDES_KM.map((altitudeKm) => ({
    name: `${region.name}-${altitudeKm}km`,
    region: region.name,
    latitudeDeg: region.latitude,
    longitudeDeg: region.longitude,
    cameraDistanceKm: altitudeKm,
  }))),
  {
    name: 'globe', region: null, latitudeDeg: 0, longitudeDeg: 0,
    cameraDistanceKm: Math.round(GLOBE_CAMERA_KM),
  },
];

const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

// 部分指定 (--regions=a,b --ladders=400,2000)。無ければ全枠 (全球を含む)。
function filterArg(name) {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return arg === undefined ? null : arg.slice(name.length + 3).split(',').filter(Boolean);
}
const regionFilter = filterArg('regions');
const ladderFilter = filterArg('ladders');
const shootList = CAPTURES.filter((capture) =>
  (regionFilter === null || (capture.region !== null && regionFilter.includes(capture.region)))
  && (ladderFilter === null || ladderFilter.includes(String(capture.cameraDistanceKm))));
if (shootList.length === 0) throw new Error('部分指定に合う撮影枠が無い');
const filter = regionFilter === null && ladderFilter === null ? null
  : { regions: regionFilter, ladders: ladderFilter };
const startedAt = Date.now();
const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: buildDir, port, debugPort, profilePrefix: 'cloud-render-capture-', onEvent,
  requestTimeoutMs: 300_000,
});
const manifest = {
  tool: 'cloud-lab-render-capture',
  reportVersion: 1,
  generatedAt: new Date().toISOString(),
  gitHead,
  filter,
  displayHours: DISPLAY_HOURS,
  fovDeg: FOV_DEG,
  viewport: { width: 960, height: VIEW_HEIGHT },
  sun: { azimuthDeg: SUN_AZIMUTH_DEG, elevationDeg: SUN_ELEVATION_DEG },
  captures: [],
};
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/render-capture.html` });
  await waitFor(
    devTools,
    "(document.getElementById('error')?.textContent || typeof window.cloudRenderCapture === 'object')",
    'the render capture page to initialise',
  );
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(`Render capture page failed to initialise: ${failure}`);

  // 出力先は、撮影が始まる直前に作り直す — ready 待ちで落ちても前回の撮影を残す。
  await devTools.evaluate('window.cloudRenderCapture.waitUntilReady()');
  let ready = await devTools.evaluate('window.cloudRenderCapture.ready()');
  // 1 回の waitUntilReady (上限 60 s) では届かないことがある — SwiftShader のフレームが
  // 重く、地球の画像の GPU 投入が 1 枚ずつ進むため。届くまで繰り返し、届かなければ投げる。
  for (let round = 2; round <= 4 && !ready; round++) {
    await devTools.evaluate('window.cloudRenderCapture.waitUntilReady()');
    ready = await devTools.evaluate('window.cloudRenderCapture.ready()');
  }
  if (!ready) throw new Error('Render capture page is not ready: earth textures did not arrive');

  // 出力先は、部分指定が無ければ撮影が始まる直前に作り直す — ready 待ちで落ちても前回の撮影を残す。
  // 部分指定のときは作り直さない (他の枠の PNG は残る)。
  if (filter === null) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  for (const capture of shootList) {
    const captureStartedAt = Date.now();
    const dataUrl = await devTools.evaluate(
      `window.cloudRenderCapture.setCapture(${JSON.stringify({
        latitudeDeg: capture.latitudeDeg,
        longitudeDeg: capture.longitudeDeg,
        cameraDistanceKm: capture.cameraDistanceKm,
        sunAzimuthDeg: SUN_AZIMUTH_DEG,
        sunElevationDeg: SUN_ELEVATION_DEG,
        displayHours: DISPLAY_HOURS,
      })}); window.cloudRenderCapture.captureSettled()`,
    );
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const file = `${capture.name}.png`;
    writeFileSync(path.join(outDir, file), png);
    const seconds = (Date.now() - captureStartedAt) / 1000;
    manifest.captures.push({
      ...capture,
      kmPerPx: Number(kmPerPx(capture.cameraDistanceKm).toFixed(3)),
      file,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    console.log(`${capture.name}: ${seconds.toFixed(1)}s ${kmPerPx(capture.cameraDistanceKm).toFixed(3)} km/px`);
  }
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (fatalEvents.length > 0) throw new Error(`Fatal events during render capture:\n${fatalEvents.join('\n')}`);
  console.log(`render-capture: ${manifest.captures.length} captures in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} finally {
  await session.close();
}
