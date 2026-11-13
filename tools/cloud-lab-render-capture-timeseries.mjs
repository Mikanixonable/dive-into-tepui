// 雲の描画経路の時系列撮影。render-capture と同じページ・同じカメラ／太陽／画角で、
// 地域サブセット × 高度 400/2000 km × 時刻梯子 [0,1,2,4,8] h を撮り、
// .cloud-lab/render-capture-timeseries/ へ残す。時刻 0 の行列 (render-capture) とは別で、
// compare の fineMotion 節が読む。既にあって gitHead が同じ枠は取り直さない
// (60 枚で 1 時間ほどかかるため、中断からの再開を想定する)。
// 部分指定: --regions=npac-storm,usec --ladders=400 のように絞ると、その枠だけ撮り、
// manifest にはその枠だけを残す (compare は無い対を飛ばすので、部分行列の測定になる)。
// 部分指定時は出力先を作り直さない — 他の枠の PNG は残るが manifest からは外れる。
// フル行列に戻すときは、撮る前に .cloud-lab/render-capture-timeseries/ を消して全枠を撮り直す。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'render-capture-timeseries');
const port = 8771;
const debugPort = 9448;

// 撮る地域。render-capture の REGIONS から、サハラを除く 6 つ (サハラは実写の時系列が
// 取れないため、時刻 0 の対だけを残す) に、陸海の層別が取れる海岸の usec を足した 7 つ。
// 直下点は cloud-lab:compare の REGIONS と同じ。usec は北米東海岸 (38.5°N 73.5°W) で、
// 400 km 梯子でも 2000 km 梯子でも陸と海が入る。
const REGIONS = [
  { name: 'npac-storm', latitude: 45, longitude: -170 },
  { name: 'natl-storm', latitude: 50, longitude: -30 },
  { name: 'so-ocean', latitude: -55, longitude: 100 },
  { name: 'sepac-subtrop', latitude: -20, longitude: -85 },
  { name: 'itcz-atl', latitude: 5, longitude: -25 },
  { name: 'typhoon', latitude: 19, longitude: 136 },
  { name: 'usec', latitude: 38.5, longitude: -73.5 },
];
// 直下視の高度 [km]。微細帯の主の梯子だけ (10000 km は時系列の対象外)。
const ALTITUDES_KM = [400, 2000];
// 撮る表示時刻 [h]。実写の時系列は現地正午を中心に [-4,-3,-2,0,+4] h で取るので、
// 刻み幅 (1,1,2,4 h) と通算 8 h がそろう。
const SAMPLE_HOURS = [0, 1, 2, 4, 8];
// 太陽: 直下点の天頂から東へ 30°。render-capture と同じく全地域・全時刻で固定する
// (時刻で太陽が動くと、雲の動きと照明の変化が混ざるため)。
const SUN_AZIMUTH_DEG = 30;
const SUN_ELEVATION_DEG = 0;
const FOV_DEG = 50;
function degToRad(deg) { return (deg * Math.PI) / 180; }
// 画面の高さ [px]。render-lab の LabView と対。
const VIEW_HEIGHT = 540;

// 直下点での 1 画素あたりの地上距離 [km/px]。
function kmPerPx(cameraDistanceKm) {
  return (2 * cameraDistanceKm * Math.tan(degToRad(FOV_DEG / 2))) / VIEW_HEIGHT;
}

const CAPTURES = REGIONS.flatMap((region) => ALTITUDES_KM.flatMap((altitudeKm) =>
  SAMPLE_HOURS.map((hours) => ({
    name: `${region.name}-${altitudeKm}km-${hours}h`,
    region: region.name,
    ladder: `${altitudeKm}km`,
    hours,
    latitudeDeg: region.latitude,
    longitudeDeg: region.longitude,
    cameraDistanceKm: altitudeKm,
  }))));

// 部分指定 (--regions=a,b --ladders=400,2000)。無ければ全枠。
function filterArg(name) {
  const arg = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return arg === undefined ? null : arg.slice(name.length + 3).split(',').filter(Boolean);
}
const regionFilter = filterArg('regions');
const ladderFilter = filterArg('ladders');
const shootList = CAPTURES.filter((capture) =>
  (regionFilter === null || regionFilter.includes(capture.region))
  && (ladderFilter === null || ladderFilter.includes(String(capture.cameraDistanceKm))));
if (shootList.length === 0) throw new Error('部分指定に合う撮影枠が無い');
const filter = regionFilter === null && ladderFilter === null ? null
  : { regions: regionFilter, ladders: ladderFilter };

const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const startedAt = Date.now();
const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: buildDir, port, debugPort, profilePrefix: 'cloud-render-capture-ts-', onEvent,
  requestTimeoutMs: 300_000,
});
const manifestPath = path.join(outDir, 'manifest.json');
let previousManifest = null;
if (existsSync(manifestPath)) {
  try {
    previousManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    previousManifest = null;
  }
}
const manifest = {
  tool: 'cloud-lab-render-capture-timeseries',
  reportVersion: 1,
  generatedAt: new Date().toISOString(),
  gitHead,
  filter,
  sampleHours: SAMPLE_HOURS,
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

  await devTools.evaluate('window.cloudRenderCapture.waitUntilReady()');
  let ready = await devTools.evaluate('window.cloudRenderCapture.ready()');
  // 1 回の waitUntilReady (上限 60 s) では届かないことがある — SwiftShader のフレームが
  // 重く、地球の画像の GPU 投入が 1 枚ずつ進むため。届くまで繰り返し、届かなければ投げる。
  for (let round = 2; round <= 4 && !ready; round++) {
    await devTools.evaluate('window.cloudRenderCapture.waitUntilReady()');
    ready = await devTools.evaluate('window.cloudRenderCapture.ready()');
  }
  if (!ready) throw new Error('Render capture page is not ready: earth textures did not arrive');

  // 出力先は作り直さない — 中断した実行の続きから撮る (gitHead が変われば全枠を撮り直す)。
  mkdirSync(outDir, { recursive: true });

  for (const capture of shootList) {
    const file = `${capture.name}.png`;
    const target = path.join(outDir, file);
    const previous = previousManifest?.gitHead === gitHead
      ? previousManifest.captures.find((entry) => entry.name === capture.name) : undefined;
    if (previous !== undefined && existsSync(target)) {
      manifest.captures.push(previous);
      console.log(`${capture.name}: skip (既にある・${previous.sha256.slice(0, 8)})`);
      continue;
    }
    const captureStartedAt = Date.now();
    const dataUrl = await devTools.evaluate(
      `window.cloudRenderCapture.setCapture(${JSON.stringify({
        latitudeDeg: capture.latitudeDeg,
        longitudeDeg: capture.longitudeDeg,
        cameraDistanceKm: capture.cameraDistanceKm,
        sunAzimuthDeg: SUN_AZIMUTH_DEG,
        sunElevationDeg: SUN_ELEVATION_DEG,
        displayHours: capture.hours,
      })}); window.cloudRenderCapture.captureSettled()`,
    );
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    writeFileSync(target, png);
    const seconds = (Date.now() - captureStartedAt) / 1000;
    manifest.captures.push({
      ...capture,
      kmPerPx: Number(kmPerPx(capture.cameraDistanceKm).toFixed(3)),
      file,
      sha256: createHash('sha256').update(png).digest('hex'),
    });
    console.log(`${capture.name}: ${seconds.toFixed(1)}s ${kmPerPx(capture.cameraDistanceKm).toFixed(3)} km/px`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (fatalEvents.length > 0) throw new Error(`Fatal events during render capture:\n${fatalEvents.join('\n')}`);
  console.log(`render-capture-timeseries: ${manifest.captures.length} captures in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
} finally {
  await session.close();
}
