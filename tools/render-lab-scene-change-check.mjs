// 変化量 d の推定(本番の重み)を、render-lab の番号を CDP から進めて確かめ、表を標準出力へ書く — 静止・恒星と地球の往復・
// カメラの並進・回転・周回・同じ番号の描き直し。期待と合わない行があれば終了コード 1。
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { openLabPage, openMotionLab } from './render-lab-motion-scenes.mjs';

const startedAt = Date.now();
const MAX_DURATION_MS = 5 * 60_000;
const rows = [];

// 全体の時間の上限を超えたら投げる。
function checkTime() {
  if (Date.now() - startedAt > MAX_DURATION_MS) throw new Error('Scene-change check exceeded five minutes');
}

// 恒星だけを光源にする描画設定の差分(天体照の数 0)。
const SUN_ONLY = { planetLightCount: 0 };

// 仰角 elevation [rad] の向きを方位で deltaDeg 回したときの、向きの間の角 [rad]。
function turnAngle(deltaDeg, elevation) {
  return 2 * Math.asin(Math.cos(elevation) * Math.sin(deltaDeg * Math.PI / 360));
}

// actual が expected に相対 tolerance で近いか(expected が 0 なら絶対 1e-12)。
function nearRelative(actual, expected, tolerance = 1e-3) {
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected) * tolerance, 1e-12);
}

// 時間の上限を確かめてから、ページで式を評価する。
async function evaluate(devTools, expression) {
  checkTime();
  return devTools.evaluate(expression);
}

// ケース caseName の撮影 shotName を描画設定の差分 graphics で置き、本番の重みにして、このケースの様子を基準にする。
async function setup(devTools, caseName, shotName, graphics = {}) {
  const registeredName = await evaluate(devTools,
    `window.renderLab.cases.find((name) => name === ${JSON.stringify(caseName)})`);
  if (registeredName === undefined) throw new Error(`Unknown render-lab case ${caseName}`);
  await evaluate(devTools,
    `window.renderLab.showShot(${JSON.stringify(registeredName)}, ${JSON.stringify(shotName)}, ${JSON.stringify(graphics)})`);
  await evaluate(devTools, 'window.renderLab.setSceneChangeWeights(null)');
  // 同じ番号 0 の描き直しは前の標本を保つため、番号を一度進めてから 0 へ戻し、このケースの標本を基準にする。
  await evaluate(devTools, 'window.renderLab.setFrame(1, Infinity)');
  await evaluate(devTools, 'window.renderLab.setFrame(0, Infinity)');
}

// 直前に番号を進めたときの推定の内訳と d。
async function read(devTools) {
  return evaluate(devTools, 'window.renderLab.sceneChange()');
}

// 表の 1 行を積む。
function record(scene, movement, sample, expected, passed) {
  rows.push({ scene, movement, ...sample, expected, passed });
}

// 表の数値(有効数字 5 桁。無ければ —)。
function formatted(value) {
  return value === null || value === undefined ? '—' : Number(value).toPrecision(5);
}

// 内訳のすべてと d がちょうど 0 か。
function allTermsAndChangeAreZero(sample) {
  return sample.change === 0 && sample.terms !== null
    && sample.terms.lightDirection === 0 && sample.terms.sunlit === 0 && sample.terms.cameraSlide === 0;
}

// 何も動かさずに番号を 4 つ進め、内訳と d がちょうど 0 かを確かめる。
async function stationary(devTools, caseName, shotName, sceneLabel = caseName) {
  await setup(devTools, caseName, shotName);
  for (let frame = 1; frame <= 4; frame++) {
    await evaluate(devTools, `window.renderLab.setFrame(${frame}, 0)`);
    const sample = await read(devTools);
    record(`${sceneLabel} 静止`, `k=${frame}`, sample, '全要素=0, d=0', allTermsAndChangeAreZero(sample));
  }
}

// 方位 angleKey を 0.5°/フレームで回す。恒星を回すときは天体照を切り(天体照の数 0)、恒星だけの向きの回転と比べる。
async function movingLight(devTools, caseName, shotName, sceneLabel, angleKey, label) {
  await setup(devTools, caseName, shotName, angleKey === 'sunAzimuthDeg' ? SUN_ONLY : {});
  const base = await evaluate(devTools, `window.renderLab.viewAngles()`);
  const elevation = (angleKey === 'sunAzimuthDeg' ? base.sunElevationDeg : base.earthElevationDeg) * Math.PI / 180;
  for (let frame = 1; frame <= 4; frame++) {
    await evaluate(devTools, `window.renderLab.setView({ ${angleKey}: ${base[angleKey]} + 0.5 * ${frame} })`);
    await evaluate(devTools, `window.renderLab.setFrame(${frame}, 0)`);
    const sample = await read(devTools);
    const fullTurn = turnAngle(0.5, elevation);
    const earthLightFraction = (sample.terms?.lightDirection ?? NaN) / fullTurn;
    const passed = angleKey === 'sunAzimuthDeg'
      ? nearRelative(sample.terms?.lightDirection ?? NaN, fullTurn)
        && sample.terms?.sunlit === 0 && sample.terms?.cameraSlide === 0
      : Number.isFinite(earthLightFraction) && earthLightFraction > 0 && earthLightFraction < 1
        && sample.terms?.cameraSlide === 0;
    const expected = angleKey === 'sunAzimuthDeg'
      ? `lightDirection≈${(fullTurn * 180 / Math.PI).toPrecision(4)}°; 他=0`
      : `lightDirection≈照度割合×${(fullTurn * 180 / Math.PI).toPrecision(4)}°; 推定割合=${earthLightFraction.toPrecision(4)}`;
    record(`${sceneLabel} ${label}`, `方位 +0.5°/frame, k=${frame}`, sample, expected, passed);
  }
}

// カメラを 1 px/フレームずつ並進・回転・周回させ、画面の滑りだけが正で 1/540 の桁かを確かめる。
async function cameraMovement(devTools, mode, movement) {
  await setup(devTools, 'cornell-box', 'cornell-box');
  await evaluate(devTools, 'window.renderLab.resetMotion()');
  // resetMotion は現在番号を描き直す。番号が同じなので、もう一度無限大 d で基準標本を置き直す。
  await evaluate(devTools, 'window.renderLab.setFrame(1, Infinity)');
  await evaluate(devTools, 'window.renderLab.setFrame(0, Infinity)');
  for (let frame = 1; frame <= 4; frame++) {
    const pixels = frame;
    const tuple = mode === 'translation' ? `[${pixels},0]` : '[0,0]';
    const rotation = mode === 'rotation' ? `[${pixels},0]` : '[0,0]';
    const orbit = mode === 'orbit' ? `[${pixels},0]` : '[0,0]';
    await evaluate(devTools, `window.renderLab.moveCamera(${tuple}, ${rotation}, ${orbit})`);
    await evaluate(devTools, `window.renderLab.setFrame(${frame}, 0)`);
    const sample = await read(devTools);
    const onlySlide = sample.terms?.lightDirection === 0 && sample.terms?.sunlit === 0
      && (sample.terms?.cameraSlide ?? 0) > 0;
    const expectedSlide = 1 / 540;
    const scaleMatches = (sample.terms?.cameraSlide ?? 0) >= expectedSlide / 2
      && (sample.terms?.cameraSlide ?? Infinity) <= expectedSlide * 2;
    record(`cornell-box カメラ ${movement}`, `1 px/frame, k=${frame}`, sample,
      'cameraSlideのみ正、値は約1/540前後', onlySlide && scaleMatches);
  }
}

// 同じ番号の描き直しで推定が変わらず、次の番号が 1 度目の描画からの差になるかを確かめる。
async function repeatFrameCheck(devTools) {
  await setup(devTools, 'cornell-box', 'cornell-box', SUN_ONLY);
  const base = await evaluate(devTools, 'window.renderLab.viewAngles()');
  await evaluate(devTools, 'window.renderLab.setView({ sunAzimuthDeg: window.renderLab.viewAngles().sunAzimuthDeg + 0.5 })');
  await evaluate(devTools, 'window.renderLab.setFrame(1, 0)');
  const first = await read(devTools);
  await evaluate(devTools, 'window.renderLab.setView({ sunAzimuthDeg: window.renderLab.viewAngles().sunAzimuthDeg + 7 })');
  const repeated = await read(devTools);
  await evaluate(devTools, 'window.renderLab.setView({ sunAzimuthDeg: window.renderLab.viewAngles().sunAzimuthDeg - 7.5 })');
  await evaluate(devTools, 'window.renderLab.setFrame(2, 0)');
  const next = await read(devTools);
  const expected = turnAngle(0.5, base.sunElevationDeg * Math.PI / 180);
  const passed = JSON.stringify(first) === JSON.stringify(repeated)
    && nearRelative(next.terms?.lightDirection ?? NaN, expected)
    && next.terms?.sunlit === 0 && next.terms?.cameraSlide === 0;
  record('cornell-box 同じ番号描き直し', 'k=1 を再描画後 k=2', next,
    `k=1 の1度目からの差≈${(expected * 180 / Math.PI).toPrecision(4)}°; 再描画保持=${JSON.stringify(first) === JSON.stringify(repeated)}`, passed);
}

const { session, devTools, fatalEvents } = await openMotionLab({
  port: 8776, debugPort: 9454, profilePrefix: 'tepui-render-lab-scene-change-',
});
try {
  await openLabPage(session);
  await stationary(devTools, 'cornell-box', 'cornell-box');
  await stationary(devTools, 'bay', 'bay-earth-open', 'bay-earth-open');
  await movingLight(devTools, 'cornell-box', 'cornell-box', 'cornell-box', 'sunAzimuthDeg', '恒星往復');
  await movingLight(devTools, 'bay', 'bay-earth-open', 'bay-earth-open', 'earthAzimuthDeg', '地球往復');
  for (const [mode, movement] of [['translation', '並進'], ['rotation', '回転'], ['orbit', '周回']]) {
    await cameraMovement(devTools, mode, movement);
  }
  await repeatFrameCheck(devTools);
  if (fatalEvents.length > 0) throw new Error(`Page reported errors:\n${fatalEvents.join('\n')}`);
} finally {
  await session.close();
}

console.log('| 場面 | 動き | lightDirection (deg) | sunlit | cameraSlide | d | 期待値 | 結果 |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | --- | --- |');
for (const row of rows) {
  const lightDeg = row.terms === null ? '—' : formatted(row.terms.lightDirection === null ? null : row.terms.lightDirection * 180 / Math.PI);
  const sunlit = row.terms === null ? '—' : formatted(row.terms.sunlit);
  const slide = row.terms === null ? '—' : formatted(row.terms.cameraSlide);
  console.log(`| ${row.scene} | ${row.movement} | ${lightDeg} | ${sunlit} | ${slide} | ${formatted(row.change)} | ${row.expected} | ${row.passed ? '一致' : '不一致'} |`);
}
console.log(`所要 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
if (rows.some(({ passed }) => !passed)) process.exitCode = 1;
