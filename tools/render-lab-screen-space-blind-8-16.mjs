// 手順8-16 の盲検の刺激を作る。8-15 で締めた帯の鎖(band-new)・8-15 の前の帯の鎖(band-pre815)・手順7 の Q(q)を、撮影ごとに
// 1 つの Chrome のページで交互に計時し、秘密の鍵 work/keys/key.json の設定で補正項・クレイ・32 組の統計の絵を書く。閲覧ページには
// 撮影名・ラベル・刺激の ID・絵の種類・パスだけを出す。band-pre815 は一時パッチを当てたビルドでだけ描けるので、走らせる前に
// work/pre815-build.mjs でビルドする(この道具はビルドしない)。
// 使い方: node tools/render-lab-screen-space-blind-8-16.mjs [--make-key <設定.json> | --check | --calibrate | --retime=<名前>]
//   [--scene=<撮影>] [--resume]
//   設定 = { levels: { L1: { 'band-new': { slices, paths }, 'band-pre815': {…}, q: {…} }, L2: {…}, L3: {…} },
//            perScene?: { <撮影>: { <L>: { <方式>: { slices, paths } } } }, predictions?: <任意> }
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';
import {
  CORRECTION_DISPLAY, captureGroups, correctionPng, spreadPng, stabilizeExposure,
} from './screen-space-blind-capture.mjs';
import { shuffled } from './screen-space-blind-order.mjs';
import { RUNS } from './screen-space-chain-runs.mjs';
import { SCENES, tierOf } from './screen-space-chain-setup.mjs';
import { HEIGHT, seedOf, shotsDir, WIDTH } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, '.render-lab');
const OUTPUT = path.join(shotsDir, 'ssd-8-16-blind');
const IMAGES = path.join(OUTPUT, 'images');
const WORK = path.join(OUTPUT, 'work');
const KEY_FILE = path.join(WORK, 'keys', 'key.json');
const BUILD_RECORD = path.join(WORK, 'pre815-build.json');
const RECORDS_FILE = path.join(WORK, 'records.json');
const TIMINGS_FILE = path.join(WORK, 'timings.json');
const CALIBRATION_FILE = path.join(WORK, 'calibration-timings.json');
const CHECKS_FILE = path.join(WORK, 'checks.json');
const VIEWER_TEMPLATE = path.join(ROOT, 'tools', 'render-lab', 'ssd-blind-viewer.html');
const PORT = 8775;
const DEBUG_PORT = 9455;
// 参照と健全性の確認が照らす、8-15 で締めた形の帯鎖の撮影の run と、8-14 の盲検の置き場。
const REFERENCE_RUN = 'k038-closed';
const BLIND_814 = path.join(shotsDir, 'ssd-8-blind');

const METHODS = ['band-new', 'band-pre815', 'q'];
const LEVELS = ['L1', 'L2', 'L3'];
// 8-15 で締めた κ と、8-15 の前の κ。
const KAPPA = 0.38;
const KAPPA_PRE815 = 0.75;
const SPARSE_TAP_COUNT = 8;
// 参照の段: 帯に分けない、8-15 の撮影と同じ走査。
const REFERENCE_TIER = { ...tierOf(KAPPA), bandCount: 1 };
// 1 パスの計時の暖機と標本のフレーム数と、パスを平均する設定の計時の標本数。
const WARMUP_FRAMES = 3;
const SAMPLE_FRAMES = 8;
const PATH_SAMPLES = 8;
// 刺激と参照の絵の種類と、閲覧ページの表示名。
const STIMULUS_VIEWS = ['first', 'second', 'clay-first', 'mean', 'clay-mean', 'deviation0', 'deviation1', 'variance'];
const REFERENCE_VIEWS = ['reference', 'reference-clay'];
const VIEW_LABELS = {
  first: '1パス(組0)', second: '1パス(組1)', 'clay-first': 'クレイ(組0)', mean: '32組平均', 'clay-mean': 'クレイ(32組平均)',
  deviation0: '偏差(組0)', deviation1: '偏差(組1)', variance: '分散',
  reference: '参照(1/4 raw 1024 パス)', 'reference-clay': '参照のクレイ',
};
// 予備の計時の設定(方式・スライス数・パス数)。
const CALIBRATION = Object.entries({
  'band-new': [[12, 1], [16, 1], [20, 1], [5, 2], [6, 2], [8, 2], [5, 4], [6, 4], [7, 4]],
  'band-pre815': [[16, 1], [6, 2], [7, 4]],
  q: [[16, 1], [20, 1], [24, 1], [6, 2], [8, 2], [10, 2], [8, 4], [9, 4], [10, 4]],
}).flatMap(([method, settings]) => settings.map(([slices, paths]) => ({ method, slices, paths })));
// 健全性の確認の基準。撮影はセッションごとに離散的に揺れるので、8 bit で 2 を超えて違う画素を数十まで許す。band-pre815 と
// 8-14 の差は band-new と 8-14 の差の PRE815_DIFFERENCE_RATIO 未満、補正を除いた拡散照度の seed による差は面の写る画素で
// 半精度の ulp の MAX_BASE_ULPS 倍(照度の加算合成の丸めの数回ぶん)まで。
const MAX_PIXELS_OVER_2 = 50;
const PRE815_DIFFERENCE_RATIO = 0.1;
const MAX_BASE_ULPS = 4;

const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const RESUME = process.argv.includes('--resume');
const selectedScenes = SCENES.filter(({ name }) => argumentOf('scene') === undefined || name === argumentOf('scene'));
if (selectedScenes.length === 0) throw new Error(`unknown scene: ${argumentOf('scene')}`);
const readJson = (file, empty) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : empty);
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const labelOf = (index) => String(index + 1).padStart(2, '0');
const pngBytes = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
const imageFile = (stimulusId, view) => path.join(IMAGES, stimulusId, `${view}.png`);

// .render-lab が work/pre815-build.mjs のビルドのままか確かめ、その記録を返す。
function pre815Build() {
  if (!existsSync(BUILD_RECORD)) throw new Error('run .render-lab-shots/ssd-8-16-blind/work/pre815-build.mjs first');
  const record = JSON.parse(readFileSync(BUILD_RECORD, 'utf8'));
  const bundles = readdirSync(BUILD_DIR).filter((name) => /^render-lab\.[0-9a-f]+\.js$/.test(name));
  if (bundles.length !== 1 || bundles[0] !== record.bundle) {
    throw new Error(`.render-lab is not the pre815 build ${record.bundle} (found ${bundles.join(', ')})`);
  }
  return record;
}

// ---- 鍵 ----

// 隣り合う 2 つの刺激が同じ方式か同じ L か。
const sameMethodOrLevel = (a, b) => a.method === b.method || a.level === b.level;

// 鍵の形と、刺激の並び・ID の規則を確かめる。
function validateKey(key) {
  const ids = new Set();
  const addId = (id) => {
    if (!/^[0-9a-f]{8}$/.test(id) || ids.has(id)) throw new Error(`invalid or duplicate stimulus ID ${id}`);
    ids.add(id);
  };
  if (key.scenes.map(({ scene }) => scene).join() !== SCENES.map(({ name }) => name).join()) {
    throw new Error('key scenes differ from the capture scenes');
  }
  for (const { scene, referenceId, stimuli } of key.scenes) {
    addId(referenceId);
    const pairs = new Set(stimuli.map(({ level, method }) => `${level}/${method}`));
    if (stimuli.length !== LEVELS.length * METHODS.length || pairs.size !== stimuli.length
      || stimuli.some(({ level, method }) => !LEVELS.includes(level) || !METHODS.includes(method))) {
      throw new Error(`${scene} must have every level and method once`);
    }
    for (const [index, stimulus] of stimuli.entries()) {
      addId(stimulus.stimulusId);
      const previous = stimuli[index - 1];
      if (stimulus.label !== labelOf(index)) throw new Error(`${scene} labels must be 01..09 in order`);
      if (previous && sameMethodOrLevel(previous, stimulus)) {
        throw new Error(`${scene} has adjacent stimuli with the same method or level`);
      }
      if (!Number.isInteger(stimulus.slices) || stimulus.slices < 1 || ![1, 2, 3, 4].includes(stimulus.paths)) {
        throw new Error(`${scene}/${stimulus.label} needs integer slices >= 1 and 1..4 paths`);
      }
    }
  }
}

// 設定ファイル configFile から鍵を作って書く。鍵が既にあれば投げる。
function makeKey(configFile) {
  if (existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} already exists`);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const seed = randomBytes(32).toString('hex');
  const ids = new Set();
  const newId = () => {
    let id = randomBytes(4).toString('hex');
    while (ids.has(id)) id = randomBytes(4).toString('hex');
    ids.add(id);
    return id;
  };
  const scenes = SCENES.map(({ name }) => {
    const stimuli = LEVELS.flatMap((level) => METHODS.map((method) => {
      const { slices, paths } = config.perScene?.[name]?.[level]?.[method] ?? config.levels[level][method];
      return { stimulusId: newId(), method, level, slices, paths };
    }));
    const ordered = shuffled(stimuli, seed, name, sameMethodOrLevel)
      .map((stimulus, index) => ({ label: labelOf(index), ...stimulus }));
    return { scene: name, referenceId: newId(), stimuli: ordered };
  });
  const key = {
    createdAt: new Date().toISOString(), randomizationSeed: seed,
    rule: 'Independent seeded shuffle per scene; adjacent stimuli cannot share a method or level.', config, scenes,
  };
  validateKey(key);
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, `${JSON.stringify(key, null, 2)}\n`, { flag: 'wx' });
  console.log(`key written: ${KEY_FILE}`);
}

// ---- ページ ----

// 撮影 scene を描画テスト環境のページに出し、計時と撮影の描画設定にして露出を落ち着かせてから work(devTools, session) を
// 走らせ、その値を返す。session は { pageUrl, adapter, exposure }。
async function withScene(scene, work) {
  const session = await openChromeSession({
    serveDir: BUILD_DIR, port: PORT, debugPort: DEBUG_PORT, profilePrefix: 'tepui-render-lab-ssd816-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools,
      "document.getElementById('error')?.textContent || typeof window.renderLab?.measureScreenSpacePaths === 'function'",
      'the render lab to initialise');
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`render lab failed to initialise: ${failure}`);
    const adapter = await devTools.evaluate(`(async () => { const a = await navigator.gpu.requestAdapter(), i = a.info ?? {};
      return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / '); })()`);
    await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shot)})`);
    await devTools.evaluate(`window.renderLab.setTarget('off');
      window.renderLab.setGraphicsOption('screenSpaceOcclusion', true); window.renderLab.setGraphicsOption('screenSpaceIndirect', true);
      window.renderLab.setGraphicsOption('screenSpaceSliceCount', 4); window.renderLab.setGraphicsOption('screenSpaceStepCount', 6);
      window.renderLab.setScanWhiteNoisePass(null)`);
    const exposure = await stabilizeExposure(devTools);
    return await work(devTools, { pageUrl: session.baseUrl, adapter, exposure });
  } finally {
    await session.close();
  }
}

// 方式 method をスライス数 slices で描く比較方式 variant と段 tier。band-pre815 は κ を負で渡して、一時パッチの帯座標
// log₂(|κ|·ρ) を選ばせる。
function experimentOf(method, slices) {
  const scan = { ...tierOf(KAPPA), sliceCount: slices };
  if (method === 'band-new') return { variant: 'band', tier: scan };
  if (method === 'band-pre815') return { variant: 'band', tier: { ...scan, bandScale: -KAPPA_PRE815 } };
  return { variant: 'q', tier: { ...scan, bandCount: 1 } };
}

// 次のフレームから方式 method をスライス数 slices で、ブルーノイズのずれで描く。
async function setMethod(devTools, method, slices) {
  const { variant, tier } = experimentOf(method, slices);
  await devTools.evaluate(`window.renderLab.setScanWhiteNoisePass(null);
    window.renderLab.setScreenSpaceExperiment(${JSON.stringify(variant)}, ${JSON.stringify(tier)}, ${SPARSE_TAP_COUNT})`);
}

// 方式 method・スライス数 slices の 1 パスを seedOf(k) で描く。
async function renderOnePass(devTools, method, slices, k) {
  await setMethod(devTools, method, slices);
  const [x, y] = seedOf(k);
  await devTools.evaluate(`window.renderLab.setScanSeed(${x}, ${y}); window.renderLab.render()`);
}

// 直前のフレームの完成補正(画素ごとに rgb)をページの window.__ssdCorrection に控える。
const holdCorrection = (devTools) => devTools.evaluate(`window.renderLab.readFloat('correction').then(({ rgba }) => {
  const rgb = new Float32Array(rgba.length / 4 * 3);
  for (let p = 0; p < rgba.length / 4; p++) for (let c = 0; c < 3; c++) rgb[3 * p + c] = rgba[4 * p + c];
  window.__ssdCorrection = rgb;
})`);

// 直前のフレームの、補正を除いた拡散照度 diffuse − correction(画素ごとに rgb)をページの window.__ssdBase に控える。
const holdBase = (devTools) => devTools.evaluate(`(async () => {
  const diffuse = (await window.renderLab.readFloat('diffuse')).rgba;
  const correction = (await window.renderLab.readFloat('correction')).rgba;
  const base = new Float32Array(diffuse.length / 4 * 3);
  for (let p = 0; p < diffuse.length / 4; p++) {
    for (let c = 0; c < 3; c++) base[3 * p + c] = diffuse[4 * p + c] - correction[4 * p + c];
  }
  window.__ssdBase = base;
})()`);

// ページの式 source が指す補正を window.__ssdBase へ足した拡散照度の、負を 0 に切った通常の合成の表示を PNG の data URL に
// する。
const clayPng = (devTools, source) => devTools.evaluate(`(async () => {
  const base = window.__ssdBase, correction = ${source}, rgba = new Float32Array(${WIDTH * HEIGHT * 4});
  for (let p = 0; p < ${WIDTH * HEIGHT}; p++) {
    for (let c = 0; c < 3; c++) rgba[4 * p + c] = Math.max(0, base[3 * p + c] + correction[3 * p + c]);
    rgba[4 * p + 3] = 1;
  }
  const display = await window.renderLab.composite({ width: ${WIDTH}, height: ${HEIGHT}, rgba });
  const canvas = document.createElement('canvas');
  canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
  const ctx = canvas.getContext('2d', { alpha: false });
  const image = ctx.createImageData(${WIDTH}, ${HEIGHT});
  for (let i = 0; i < image.data.length; i++) {
    image.data[i] = i % 4 === 3 ? 255 : Math.round(255 * Math.max(0, Math.min(1, display.rgba[i])));
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
})()`);

// 絵 dataUrl を刺激 stimulusId の絵の種類 view として書く。
function writeImage(stimulusId, view, dataUrl) {
  mkdirSync(path.join(IMAGES, stimulusId), { recursive: true });
  writeFileSync(imageFile(stimulusId, view), pngBytes(dataUrl));
}

// 8 bit の 2 枚の絵 a・b(PNG)の rgb の差: 成分の平均絶対差・最大差と、どれかの成分が 2 を超えて違う画素の数。
function pngDifference(a, b) {
  const [x, y] = [decodePng(a), decodePng(b)];
  if (x.width !== y.width || x.height !== y.height) throw new Error('compared images differ in size');
  let [sum, maximum, pixelsOver2] = [0, 0, 0];
  for (let p = 0; p < x.width * x.height; p++) {
    let over = false;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(x.data[p * x.channels + c] - y.data[p * y.channels + c]);
      sum += d;
      maximum = Math.max(maximum, d);
      over ||= d > 2;
    }
    if (over) pixelsOver2++;
  }
  return { meanAbsolute: sum / (x.width * x.height * 3), maximum, pixelsOver2 };
}

// ---- 計時 ----

// 設定の並び entries を測る 3 巡の順: そのまま・逆順・方式が交互になる並び(方式ごとの順は alternateFrom の順)。
function roundOrders(entries, alternateFrom = entries) {
  const queues = METHODS.map((method) => alternateFrom.filter((entry) => entry.method === method));
  const alternating = [];
  for (let i = 0; alternating.length < entries.length; i++) {
    for (const queue of queues) if (i < queue.length) alternating.push(queue[i]);
  }
  return [entries, [...entries].reverse(), alternating];
}

// 設定 { method, slices, paths } を同じページで 1 回測る。rows は GPU の全行の p50 [ms]、nearbyDiffuseMs はそのうち近傍
// 拡散の行の和。1 パスはふつうのフレームを、2 パス以上はパスを平均する候補を測る。
async function measureEntry(devTools, { method, slices, paths }) {
  await setMethod(devTools, method, slices);
  const seeds = Array.from({ length: paths }, (_, p) => seedOf(p));
  await devTools.evaluate(`window.renderLab.setScanSeed(${seeds[0][0]}, ${seeds[0][1]})`);
  const result = await devTools.evaluate(paths === 1
    ? `window.renderLab.measureCurrent(${WARMUP_FRAMES}, ${SAMPLE_FRAMES})`
    : `window.renderLab.measureScreenSpacePaths(${JSON.stringify(seeds)}, ${PATH_SAMPLES})`);
  if (!result.gpuSupported) throw new Error('GPU timestamp queries unavailable');
  const rows = Object.fromEntries(Object.entries(result.gpuPassMsById).map(([id, { p50 }]) => [id, p50]));
  const nearbyDiffuseMs = Object.entries(rows).filter(([id]) => id.startsWith('nearbyDiffuse'))
    .reduce((sum, [, ms]) => sum + ms, 0);
  return { rows, nearbyDiffuseMs, cpuRenderP50Ms: result.cpuRenderMs?.p50 ?? null, measuredAt: new Date().toISOString() };
}

// 予備の計時: 撮影ごとに CALIBRATION を 3 巡測って CALIBRATION_FILE へ書く。
async function calibrate() {
  const build = pre815Build();
  const record = readJson(CALIBRATION_FILE, { scenes: {} });
  Object.assign(record, {
    bundle: build.bundle, pre815Build: build, startedAt: new Date().toISOString(), finishedAt: null,
  });
  for (const scene of selectedScenes) {
    await withScene(scene, async (devTools, session) => {
      const sceneRecord = { ...session, startedAt: new Date().toISOString(), finishedAt: null, rounds: [] };
      record.scenes[scene.name] = sceneRecord;
      for (const [index, order] of roundOrders(CALIBRATION).entries()) {
        const names = order.map(({ method, slices, paths }) => `${method} ${slices}x${paths}`);
        const round = { round: index + 1, order: names, measurements: [] };
        sceneRecord.rounds.push(round);
        for (const entry of order) {
          console.log(`calibrate ${scene.name} round ${index + 1}: ${entry.method} ${entry.slices}x${entry.paths}`);
          round.measurements.push({ ...entry, ...(await measureEntry(devTools, entry)) });
          writeJson(CALIBRATION_FILE, record);
        }
      }
      sceneRecord.finishedAt = new Date().toISOString();
    });
  }
  record.finishedAt = new Date().toISOString();
  writeJson(CALIBRATION_FILE, record);
}

// ---- 健全性の確認 ----

// band-new の中の段の 1 パス(seed 0)の補正項を、8-15 の撮影 REFERENCE_RUN の同じ絵と比べる。
async function checkChainMetrics(devTools, sceneName) {
  await renderOnePass(devTools, 'band-new', tierOf(KAPPA).sliceCount, 0);
  await holdCorrection(devTools);
  const png = pngBytes(await correctionPng(devTools, 'window.__ssdCorrection', CORRECTION_DISPLAY.gpu));
  writeFileSync(path.join(WORK, 'checks', `${sceneName}-band-new-medium.png`), png);
  return pngDifference(png, readFileSync(path.join(RUNS, REFERENCE_RUN, sceneName, 'one-pass-correction.png')));
}

// 8-14 の盲検の 16 スライス×1 パスの帯の刺激 stimulusId の組 0 を、band-pre815 と band-new の同じ設定と、8-14 がその絵に
// 使った表示で比べる。
async function check814(devTools, sceneName, stimulusId) {
  const manifest = JSON.parse(readFileSync(path.join(BLIND_814, 'work', 'display-manifest.json'), 'utf8')).images;
  const shown = manifest.find((image) => image.stimulusId === stimulusId && image.view === 'first');
  const blind = readFileSync(path.join(BLIND_814, 'images', stimulusId, 'first.png'));
  const differenceOf = async (method) => {
    await renderOnePass(devTools, method, 16, 0);
    await holdCorrection(devTools);
    const png = pngBytes(await correctionPng(devTools, 'window.__ssdCorrection', shown.transform, shown.exposureFactor));
    writeFileSync(path.join(WORK, 'checks', `${sceneName}-${method}-16x1.png`), png);
    return pngDifference(png, blind);
  };
  return {
    stimulusId, transform: shown.transform, exposureFactor814: shown.exposureFactor,
    exposureNow: await devTools.evaluate('window.renderLab.exposureFactor()'),
    pre815: await differenceOf('band-pre815'), bandNew: await differenceOf('band-new'),
  };
}

// band-new の中の段の 1 パスを seed 0 と 1 で描き、補正を除いた拡散照度 diffuse − correction の seed による差を、補正の
// 大きさと半精度の ulp(その画素の拡散照度と土台の大きいほう)で、面の写る画素(surface)と虚空の画素(void)に分けて測る。
// 虚空の画素の拡散照度は、ライティングが隣の面の uv で引いたもの(隣の画素の補正を含む)。
async function checkBase(devTools) {
  for (const k of [0, 1]) {
    await renderOnePass(devTools, 'band-new', tierOf(KAPPA).sliceCount, k);
    await devTools.evaluate(`(async () => {
      (window.__ssdBaseCheck ??= [])[${k}] = { diffuse: (await window.renderLab.readFloat('diffuse')).rgba,
        correction: (await window.renderLab.readFloat('correction')).rgba };
    })()`);
  }
  return devTools.evaluate(`(async () => {
    const [a, b] = window.__ssdBaseCheck, radius = (await window.renderLab.readFloat('projected-radius')).rgba;
    const ulpOf = (v) => Math.max(2 ** (Math.floor(Math.log2(v)) - 10), 2 ** -24);
    const empty = () => ({ maxAbsolute: 0, squares: 0, maxUlps: 0, componentsOver2Ulps: 0, components: 0,
      correctionSquares: 0, correctionDifferenceSquares: 0 });
    const sums = { surface: empty(), void: empty() };
    for (let i = 0; i < a.diffuse.length; i++) {
      if (i % 4 === 3) continue;
      const s = radius[i - i % 4] > 0 ? sums.surface : sums.void;
      const [baseA, baseB] = [a.diffuse[i] - a.correction[i], b.diffuse[i] - b.correction[i]];
      const d = Math.abs(baseA - baseB);
      const magnitude = Math.max(Math.abs(a.diffuse[i]), Math.abs(b.diffuse[i]), Math.abs(baseA), Math.abs(baseB));
      const ulps = d === 0 ? 0 : d / ulpOf(magnitude);
      s.maxAbsolute = Math.max(s.maxAbsolute, d); s.squares += d * d; s.maxUlps = Math.max(s.maxUlps, ulps);
      if (ulps > 2) s.componentsOver2Ulps++;
      s.correctionSquares += a.correction[i] ** 2; s.correctionDifferenceSquares += (a.correction[i] - b.correction[i]) ** 2;
      s.components++;
    }
    delete window.__ssdBaseCheck;
    const summary = ({ squares, correctionSquares, correctionDifferenceSquares, ...s }) => ({ ...s,
      rms: Math.sqrt(squares / s.components), correctionRms: Math.sqrt(correctionSquares / s.components),
      correctionSeedDifferenceRms: Math.sqrt(correctionDifferenceSquares / s.components) });
    return { surface: summary(sums.surface), void: summary(sums.void) };
  })()`);
}

// 健全性の確認の撮影。どれも band-new の中の段の 1 パスと参照を 8-15 の撮影と比べ、blind814 は照らす 8-14 の盲検の刺激、
// base は補正を除いた拡散照度の seed による差を測るか。
const CHECKS = [
  { name: 'cornell-box', blind814: '055e3f72', base: false },
  { name: 'bay-dark', blind814: '4fbdf88c', base: true },
  { name: 'angled-bounce', blind814: null, base: true },
];

// 健全性の確認を撮影ごとのセッションで測って CHECKS_FILE へ書き、基準を外れたものがあれば投げる。
async function check() {
  const build = pre815Build();
  mkdirSync(path.join(WORK, 'checks'), { recursive: true });
  const results = { build, startedAt: new Date().toISOString(), scenes: {} };
  for (const { name, blind814, base } of CHECKS) {
    const scene = SCENES.find((item) => item.name === name);
    results.scenes[name] = await withScene(scene, async (devTools, session) => {
      const chainMetrics = await checkChainMetrics(devTools, name);
      const reference = await renderReference(devTools, scene);
      writeFileSync(path.join(WORK, 'checks', `${name}-reference.png`), pngBytes(reference.dataUrl));
      return {
        session, chainMetrics, referenceBypass: reference.bypassDifference,
        blind814: blind814 === null ? null : await check814(devTools, name, blind814),
        base: base ? await checkBase(devTools) : null,
      };
    });
  }
  results.finishedAt = new Date().toISOString();
  writeJson(CHECKS_FILE, results);
  const failures = Object.entries(results.scenes).flatMap(([name, { chainMetrics, referenceBypass, blind814, base }]) => [
    chainMetrics.pixelsOver2 > MAX_PIXELS_OVER_2 && `${name}: band-new differs from ${REFERENCE_RUN}`,
    referenceBypass.pixelsOver2 > MAX_PIXELS_OVER_2 && `${name}: the reference differs from the ${REFERENCE_RUN} bypass`,
    blind814 !== null && blind814.pre815.pixelsOver2 > MAX_PIXELS_OVER_2 && `${name}: band-pre815 differs from 8-14`,
    blind814 !== null && !(blind814.pre815.meanAbsolute < blind814.bandNew.meanAbsolute * PRE815_DIFFERENCE_RATIO)
      && `${name}: band-pre815 is not much closer to 8-14 than band-new`,
    base !== null && base.surface.maxUlps > MAX_BASE_ULPS && `${name}: diffuse − correction depends on the seed on surfaces`,
  ].filter(Boolean));
  console.log(JSON.stringify(results, null, 2));
  if (failures.length > 0) throw new Error(`checks failed:\n${failures.join('\n')}`);
}

// ---- 本番 ----

// 刺激 stimulus を描いて補正項・クレイ・統計の絵を書き、私的な記録(露出係数・偏差と分散の飽和した画素の割合)を返す。
async function captureStimulus(devTools, scene, stimulus) {
  const { stimulusId, method, slices, paths } = stimulus;
  await renderOnePass(devTools, method, slices, 0);
  await holdBase(devTools);
  const exposureFactor = await devTools.evaluate('window.renderLab.exposureFactor()');
  await captureGroups(devTools, paths, `${scene.name}/${stimulus.label}`);
  const exposureAfter = await devTools.evaluate('window.renderLab.exposureFactor()');
  if (Math.abs(exposureAfter - exposureFactor) > Math.max(1, Math.abs(exposureFactor)) * 1e-7) {
    throw new Error(`exposure changed during ${scene.name}/${stimulus.label}: ${exposureFactor} -> ${exposureAfter}`);
  }
  const result = 'window.__ssdBlind.result';
  for (const view of ['first', 'second', 'mean']) {
    writeImage(stimulusId, view, await correctionPng(devTools, `${result}.${view}`, CORRECTION_DISPLAY.gpu));
  }
  const saturatedFraction = {};
  for (const view of ['deviation0', 'deviation1', 'variance']) {
    const { dataUrl, saturatedFraction: fraction } = await spreadPng(devTools, view);
    writeImage(stimulusId, view, dataUrl);
    saturatedFraction[view] = fraction;
  }
  writeImage(stimulusId, 'clay-first', await clayPng(devTools, `${result}.first`));
  writeImage(stimulusId, 'clay-mean', await clayPng(devTools, `${result}.mean`));
  await devTools.evaluate('delete window.__ssdBlind; delete window.__ssdBase');
  return { scene: scene.name, exposureFactor, saturatedFraction, capturedAt: new Date().toISOString() };
}

// 撮影 scene の参照を描く: REFERENCE_RUN の 1024 パスの走査の帯の和(1/4 raw)を帯に分けない段の鎖の入力に置き、最後の
// 拡大へ A = 1 で通す。補正と土台をページに控え、補正項の PNG の data URL と、同じ run の帯和迂回の補正項との差を返す。
// 拡大と段の範囲は本番へ戻す。
async function renderReference(devTools, scene) {
  const runDir = path.join(RUNS, REFERENCE_RUN, scene.name);
  const bandSum = readFileSync(path.join(runDir, 'band-sum-1024.rgba.f32')).toString('base64');
  await devTools.evaluate(`window.renderLab.setScanWhiteNoisePass(null); window.renderLab.setScanSeed(0, 0);
    window.renderLab.setScreenSpaceExperiment(null, ${JSON.stringify(REFERENCE_TIER)}); window.renderLab.render()`);
  try {
    await devTools.evaluate(`window.renderLab.writePackedBands(0,
      new Float32Array(Uint8Array.fromBase64('${bandSum}').buffer))`);
    await devTools.evaluate(`window.renderLab.setScanStageRange('chain'); window.renderLab.setUpsampleAlphaOne(true);
      window.renderLab.render()`);
    await holdCorrection(devTools);
    await holdBase(devTools);
  } finally {
    await devTools.evaluate("window.renderLab.setUpsampleAlphaOne(false); window.renderLab.setScanStageRange('all')");
  }
  const dataUrl = await correctionPng(devTools, 'window.__ssdCorrection', CORRECTION_DISPLAY.gpu);
  const bypass = readFileSync(path.join(runDir, 'bypass-mean-1024-correction.png'));
  return { dataUrl, bypassDifference: pngDifference(pngBytes(dataUrl), bypass) };
}

// 撮影 scene の参照の補正項とクレイを参照の ID referenceId の絵へ書き、同じ run の帯和迂回の補正項との差を返す。
async function captureReference(devTools, scene, referenceId) {
  const { dataUrl, bypassDifference } = await renderReference(devTools, scene);
  writeImage(referenceId, 'reference', dataUrl);
  writeImage(referenceId, 'reference-clay', await clayPng(devTools, 'window.__ssdCorrection'));
  return bypassDifference;
}

// 撮影 scene の刺激の並び stimuli を、撮影の side('before' か 'after')の 3 巡測って timings へ足す。
async function measureRounds(devTools, scene, side, stimuli, timings) {
  const byLevel = [...stimuli].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  for (const [index, order] of roundOrders(stimuli, byLevel).entries()) {
    const round = { scene: scene.name, side, round: index + 1, order: order.map(({ label }) => label), measurements: [] };
    const others = timings.rounds.filter((item) => item.scene !== round.scene || item.side !== side || item.round !== round.round);
    timings.rounds = [...others, round];
    for (const stimulus of order) {
      console.log(`timing ${scene.name} ${side} round ${index + 1}: ${stimulus.label}`);
      round.measurements.push({ ...stimulus, ...(await measureEntry(devTools, stimulus)) });
      writeJson(TIMINGS_FILE, timings);
    }
  }
}

// 鍵 key の刺激と参照のうち絵のあるものから、閲覧ページのデータ viewer-data.json と index.html を書く。
function writeViewer(key) {
  const images = key.scenes.flatMap(({ referenceId, stimuli }) => [
    ...stimuli.flatMap(({ stimulusId }) => STIMULUS_VIEWS.map((view) => ({ stimulusId, view }))),
    ...REFERENCE_VIEWS.map((view) => ({ stimulusId: referenceId, view })),
  ]).filter(({ stimulusId, view }) => existsSync(imageFile(stimulusId, view)))
    .map(({ stimulusId, view }) => ({ stimulusId, view, path: `images/${stimulusId}/${view}.png` }));
  const data = {
    notePrefix: 'ssd8-16-blind-v1/', scenes: key.scenes.map(({ scene }) => scene),
    labels: key.scenes[0].stimuli.map(({ label }) => label),
    views: STIMULUS_VIEWS, referenceViews: REFERENCE_VIEWS, viewLabels: VIEW_LABELS,
    assignments: key.scenes.map(({ scene, referenceId, stimuli }) => ({
      scene, candidates: stimuli.map(({ label, stimulusId }) => ({ label, stimulusId })),
      reference: { stimulusId: referenceId },
    })),
    images,
  };
  writeJson(path.join(OUTPUT, 'viewer-data.json'), data);
  const serialized = JSON.stringify(data).replaceAll('<', '\\u003c');
  const html = readFileSync(VIEWER_TEMPLATE, 'utf8').replace('__VIEWER_DATA__', () => serialized);
  writeFileSync(path.join(OUTPUT, 'index.html'), html);
}

// 確かめた鍵。無ければ投げる。
function readKey() {
  const key = readJson(KEY_FILE, null);
  if (key === null) throw new Error(`no key: ${KEY_FILE}`);
  validateKey(key);
  return key;
}

// 鍵の設定で撮影ごとに計時(撮影の前後に 3 巡ずつ)・刺激・参照を撮る。--resume は絵と記録の揃った刺激と参照を飛ばす。
async function produce() {
  const build = pre815Build();
  const key = readKey();
  const records = readJson(RECORDS_FILE, { stimuli: {}, references: {} });
  const timings = readJson(TIMINGS_FILE, { rounds: [], sessions: {} });
  const done = (id) => records.stimuli[id] !== undefined && STIMULUS_VIEWS.every((view) => existsSync(imageFile(id, view)));
  const referenceDone = (scene, id) => records.references[scene] !== undefined
    && REFERENCE_VIEWS.every((view) => existsSync(imageFile(id, view)));
  for (const scene of selectedScenes) {
    const { referenceId, stimuli } = key.scenes.find((item) => item.scene === scene.name);
    if (RESUME && timings.sessions[scene.name]?.finishedAt && referenceDone(scene.name, referenceId)
      && stimuli.every(({ stimulusId }) => done(stimulusId))) {
      console.log(`resume: ${scene.name} is complete`);
      continue;
    }
    await withScene(scene, async (devTools, session) => {
      const startedAt = new Date().toISOString();
      timings.sessions[scene.name] = { ...session, bundle: build.bundle, startedAt, finishedAt: null };
      await measureRounds(devTools, scene, 'before', stimuli, timings);
      for (const stimulus of stimuli) {
        if (RESUME && done(stimulus.stimulusId)) continue;
        console.log(`capture ${scene.name}/${stimulus.label}`);
        records.stimuli[stimulus.stimulusId] = await captureStimulus(devTools, scene, stimulus);
        writeJson(RECORDS_FILE, records);
        writeViewer(key);
      }
      await measureRounds(devTools, scene, 'after', stimuli, timings);
      if (!(RESUME && referenceDone(scene.name, referenceId))) {
        const bypassDifference = await captureReference(devTools, scene, referenceId);
        records.references[scene.name] = { referenceId, bypassDifference };
        writeJson(RECORDS_FILE, records);
      }
      timings.sessions[scene.name].finishedAt = new Date().toISOString();
      writeJson(TIMINGS_FILE, timings);
    });
    writeViewer(key);
  }
}

// 計時だけを足す: 撮影ごとに新しいセッションで鍵の刺激を side 'retime-<name>' の 3 巡測り、TIMINGS_FILE の rounds へ、
// セッションの情報を retimeSessions[name][撮影] へ書く。
async function retime(name) {
  const build = pre815Build();
  const key = readKey();
  const timings = readJson(TIMINGS_FILE, { rounds: [], sessions: {} });
  timings.retimeSessions ??= {};
  for (const scene of selectedScenes) {
    const { stimuli } = key.scenes.find((item) => item.scene === scene.name);
    await withScene(scene, async (devTools, session) => {
      const record = { ...session, bundle: build.bundle, startedAt: new Date().toISOString(), finishedAt: null };
      (timings.retimeSessions[name] ??= {})[scene.name] = record;
      await measureRounds(devTools, scene, `retime-${name}`, stimuli, timings);
      record.finishedAt = new Date().toISOString();
      writeJson(TIMINGS_FILE, timings);
    });
  }
}

mkdirSync(WORK, { recursive: true });
const makeKeyIndex = process.argv.indexOf('--make-key');
if (makeKeyIndex >= 0) makeKey(process.argv[makeKeyIndex + 1]);
else if (process.argv.includes('--check')) await check();
else if (process.argv.includes('--calibrate')) await calibrate();
else if (argumentOf('retime') !== undefined) await retime(argumentOf('retime'));
else await produce();
