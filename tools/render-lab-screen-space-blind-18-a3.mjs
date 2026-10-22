// 手順18-a3の候補をシーン別JSONから読み、計時記録と非公開の鍵を画像・閲覧ページから分けて作る。
// 使い方:
//   node tools/render-lab-screen-space-blind-18-a3.mjs --make-key [設定.json]
//     省略時は tracked な tools/render-lab-screen-space-blind-18-a3-config.json を使う。
//   node tools/render-lab-screen-space-blind-18-a3.mjs --measure-only [--scene=<name>]
//   node tools/render-lab-screen-space-blind-18-a3.mjs --capture-only [--scene=<name>]
//
// 設定:
// { scenes: [{ name, caseName, shotName, candidates: [{ name, budget, graphics }] }] }
// graphics は screenSpaceOcclusion, screenSpaceIndirect, screenSpaceScanScale,
// screenSpaceBandCount, screenSpaceSliceCount, screenSpaceStepCount,
// screenSpaceDirectionalPlanetCount, screenSpaceHistoryCap(必ず1),
// screenSpaceUpsampleTapCount をすべて含む。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';
import {
  CORRECTION_DISPLAY, captureProductionPhases, correctionPng, spreadPng, stabilizeExposure,
} from './screen-space-blind-capture.mjs';
import { shuffled } from './screen-space-blind-order.mjs';
import { shotsDir, WIDTH, HEIGHT } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, '.render-lab');
const OUTPUT = path.join(shotsDir, 'ssd-18-a3-blind');
const IMAGES = path.join(OUTPUT, 'images');
const WORK = path.join(shotsDir, 'ssd-18-a3-work');
const TRACKED_CONFIG_FILE = path.join(ROOT, 'tools', 'render-lab-screen-space-blind-18-a3-config.json');
const KEY_FILE = path.join(WORK, 'keys', 'key.json');
const CONFIG_FILE = path.join(WORK, 'config.json');
const RECORDS_FILE = path.join(WORK, 'records.json');
const TIMINGS_FILE = path.join(WORK, 'timings.json');
const VIEWER_TEMPLATE = path.join(ROOT, 'tools', 'render-lab', 'ssd-blind-viewer.html');
const PORT = 8786;
const DEBUG_PORT = 9462;
const MATERIAL_ID = 'material';
const SCREEN_SPACE_IDS = [
  'nearbyDiffuseHistoryCopy', 'nearbyDiffuseScanSurface', 'nearbyDiffuseScan',
  'nearbyDiffuseInputPyramid', 'nearbyDiffuseBandReduce', 'nearbyDiffuseMerge',
  'nearbyDiffuseDenoise', 'nearbyDiffuseUpsample', 'nearbyDiffuseAccumulation',
  'nearbyDiffuseAverage',
];
const GRAPHICS_KEYS = [
  'screenSpaceOcclusion', 'screenSpaceIndirect', 'screenSpaceScanScale', 'screenSpaceBandCount',
  'screenSpaceSliceCount', 'screenSpaceStepCount', 'screenSpaceDirectionalPlanetCount',
  'screenSpaceHistoryCap', 'screenSpaceUpsampleTapCount',
];
const VIEWS = [
  'production', 'first', 'second', 'mean', 'deviation0', 'deviation1', 'variance',
  'clay-production', 'clay-first', 'clay-mean',
];
const VIEW_LABELS = {
  production: '本番ジッター 位相0',
  first: '本番ジッター 位相0（標本1）',
  second: '本番ジッター 位相1（標本2）',
  mean: '本番ジッター 32フレーム平均',
  deviation0: '本番ジッター偏差（位相0）',
  deviation1: '本番ジッター偏差（位相1）',
  variance: '本番ジッター32フレーム分散',
  'clay-production': 'クレイ + 本番ジッター 位相0',
  'clay-first': 'クレイ + 本番ジッター（位相0）',
  'clay-mean': 'クレイ + 本番ジッター32フレーム平均',
};
const BASE_GRAPHICS = {
  screenSpaceSpecular: true,
  screenSpaceSpecularScale: 0.5,
  screenSpaceSpecularStepCount: 32,
  screenSpaceSpecularDenoise: false,
};
const readJson = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const imageFile = (id, view) => path.join(IMAGES, id, `${view}.png`);
const pngBytes = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const labelOf = (index) => String(index + 1).padStart(2, '0');
function writeImage(stimulusId, view, dataUrl) {
  const file = imageFile(stimulusId, view);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, pngBytes(dataUrl));
}

function expandConfig(config) {
  if (!Array.isArray(config?.candidates) || !Array.isArray(config.scenes)) return config;
  const { candidates, scenes, ...properties } = config;
  return {
    ...properties,
    scenes: scenes.map((scene) => ({ ...scene, candidates })),
  };
}

function validateConfig(config) {
  if (!config || !Array.isArray(config.scenes) || config.scenes.length === 0) throw new Error('config needs non-empty scenes[]');
  const candidateCount = config.scenes[0].candidates?.length;
  const candidateSignature = (candidate) => JSON.stringify({
    name: candidate.name, budget: candidate.budget,
    graphics: Object.fromEntries(Object.entries(candidate.graphics ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  });
  let sharedCandidates = null;
  const names = new Set();
  for (const scene of config.scenes) {
    if (typeof scene.name !== 'string' || !scene.name || names.has(scene.name)
      || typeof scene.caseName !== 'string' || typeof scene.shotName !== 'string') {
      throw new Error('each scene needs a unique name, caseName and shotName');
    }
    names.add(scene.name);
    if (!Array.isArray(scene.candidates) || scene.candidates.length < 2 || scene.candidates.length !== candidateCount) {
      throw new Error(`${scene.name} needs the same candidate count (at least two) as every other scene`);
    }
    const candidateNames = new Set();
    for (const candidate of scene.candidates) {
      if (typeof candidate.name !== 'string' || !candidate.name || candidateNames.has(candidate.name)
        || !['low', 'medium', 'high'].includes(candidate.budget)) {
        throw new Error(`${scene.name} candidates need unique private names and low/medium/high budgets`);
      }
      candidateNames.add(candidate.name);
      if (!candidate.graphics || Object.keys(candidate.graphics).length !== GRAPHICS_KEYS.length
        || GRAPHICS_KEYS.some((key) => !(key in candidate.graphics))) {
        throw new Error(`${scene.name}/${candidate.name} must specify every screen-space graphics knob`);
      }
      const g = candidate.graphics;
      if (g.screenSpaceHistoryCap !== 1) throw new Error(`${scene.name}/${candidate.name} must explicitly use s=1`);
      if (typeof g.screenSpaceOcclusion !== 'boolean' || typeof g.screenSpaceIndirect !== 'boolean'
        || ![0.125, 0.25, 0.5, 1].includes(g.screenSpaceScanScale)
        || !Number.isInteger(g.screenSpaceBandCount) || g.screenSpaceBandCount < 4 || g.screenSpaceBandCount > 8
        || !Number.isInteger(g.screenSpaceSliceCount) || g.screenSpaceSliceCount < 1 || g.screenSpaceSliceCount > 8
        || !Number.isInteger(g.screenSpaceStepCount) || g.screenSpaceStepCount < 1 || g.screenSpaceStepCount > 12
        || ![0, 1, 2].includes(g.screenSpaceDirectionalPlanetCount)
        || !Number.isInteger(g.screenSpaceUpsampleTapCount) || g.screenSpaceUpsampleTapCount < 2 || g.screenSpaceUpsampleTapCount > 8) {
        throw new Error(`${scene.name}/${candidate.name} has an invalid screen-space setting`);
      }
    }
    const signatures = scene.candidates.map(candidateSignature).sort();
    if (sharedCandidates === null) sharedCandidates = signatures;
    else if (JSON.stringify(signatures) !== JSON.stringify(sharedCandidates)) {
      throw new Error(`${scene.name} must use the same candidate names, budgets, and settings as every other scene`);
    }
  }
}

function makeKey(configFile, replaceExisting) {
  if (existsSync(KEY_FILE) && !replaceExisting) throw new Error(`private key already exists: ${KEY_FILE}; pass --replace-key to reconfigure candidates`);
  const config = expandConfig(JSON.parse(readFileSync(configFile, 'utf8')));
  validateConfig(config);
  const seed = randomBytes(32).toString('hex');
  const ids = new Set();
  const newId = () => {
    let id = randomBytes(8).toString('hex');
    while (ids.has(id)) id = randomBytes(8).toString('hex');
    ids.add(id);
    return id;
  };
  const sharedOrder = shuffled(config.scenes[0].candidates, seed, 'all-scenes', () => false).map(({ name }) => name);
  const scenes = config.scenes.map((scene) => ({
    scene: scene.name,
    candidates: sharedOrder.map((name, index) => ({
      ...scene.candidates.find((candidate) => candidate.name === name),
      label: labelOf(index), stimulusId: newId(),
    })),
  }));
  const key = {
    createdAt: new Date().toISOString(), randomizationSeed: seed,
    ratingNamespace: randomBytes(8).toString('hex'), config, scenes,
  };
  mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, `${JSON.stringify(key, null, 2)}\n`);
  writeJson(CONFIG_FILE, config);
  writeJson(TIMINGS_FILE, { keySeed: seed, complete: false, scenes: {} });
  writeJson(RECORDS_FILE, { scenes: {} });
  if (replaceExisting) {
    for (const file of ['index.html', 'viewer-data.json']) {
      const publicFile = path.join(OUTPUT, file);
      if (existsSync(publicFile)) unlinkSync(publicFile);
    }
  }
  console.log(`private key written outside the blind gallery: ${KEY_FILE}`);
}

function loadKey() {
  const key = readJson(KEY_FILE, null);
  if (!key) throw new Error(`run --make-key <config.json> first; expected ${KEY_FILE}`);
  validateConfig(key.config);
  return key;
}

function candidateGraphics(candidate) {
  return { ...BASE_GRAPHICS, ...candidate.graphics };
}

async function setCandidate(devTools, candidate) {
  for (const key of GRAPHICS_KEYS) {
    await devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(candidate.graphics[key])})`);
  }
}

async function captureCandidate(devTools, scene, candidate) {
  await setCandidate(devTools, candidate);
  const exposure = await devTools.evaluate('window.renderLab.exposureFactor()');
  await devTools.evaluate('window.renderLab.render()');
  await devTools.evaluate(`Promise.all([
    window.renderLab.readFloat('correction'), window.renderLab.readFloat('diffuse'),
  ]).then(([correction, diffuse]) => {
    const source = new Float32Array(${WIDTH * HEIGHT * 3});
    const rgb = new Float32Array(${WIDTH * HEIGHT * 3});
    for (let p = 0, j = 0; p < ${WIDTH * HEIGHT}; p++, j += 3) {
      source[j] = correction.rgba[p * 4]; source[j + 1] = correction.rgba[p * 4 + 1]; source[j + 2] = correction.rgba[p * 4 + 2];
      rgb[j] = diffuse.rgba[p * 4]; rgb[j + 1] = diffuse.rgba[p * 4 + 1]; rgb[j + 2] = diffuse.rgba[p * 4 + 2];
    }
    window.__ssd18Production = source;
    window.__ssd18Base = rgb;
  })`);
  // 本番位相列の0は静止画本番位相と同じ入力なので、GPU出力も全RGB要素で完全一致する。
  await devTools.evaluate('window.renderLab.renderProductionCorrectionPhase(0)');
  const productionPhase0Comparison = await devTools.evaluate(`window.renderLab.readFloat('upsampled-correction').then(({ rgba }) => {
    const production = window.__ssd18Production;
    let maxAbsoluteDifference = 0, differentRgbValues = 0;
    for (let p = 0; p < production.length; p++) {
      const difference = Math.abs(production[p] - rgba[Math.floor(p / 3) * 4 + p % 3]);
      if (difference !== 0) differentRgbValues++;
      maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
    }
    return { comparedRgbValues: production.length, differentRgbValues, maxAbsoluteDifference };
  })`);
  if (productionPhase0Comparison.differentRgbValues !== 0) {
    throw new Error(`production render differs from production jitter phase 0: ${JSON.stringify(productionPhase0Comparison)}`);
  }
  const productionImage = await correctionPng(devTools, 'window.__ssd18Production', CORRECTION_DISPLAY.gpu);
  writeImage(candidate.stimulusId, 'production', productionImage);
  const captureProvenance = await captureProductionPhases(devTools, `${scene.name}/${candidate.label}`);
  const varianceStats = await devTools.evaluate(`(() => {
    const variance = window.__ssdBlind.result.variance, perPixel = new Array(${WIDTH * HEIGHT});
    for (let p = 0, i = 0; p < perPixel.length; p++, i += 3) {
      perPixel[p] = (variance[i] + variance[i + 1] + variance[i + 2]) / 3;
    }
    const sorted = [...perPixel].sort((a, b) => a - b);
    return {
      meanPerPixelRgbVariance: perPixel.reduce((sum, value) => sum + value, 0) / perPixel.length,
      p95PerPixelRgbVariance: sorted[Math.ceil(0.95 * sorted.length) - 1],
      varianceDefinition: 'per-pixel arithmetic mean of RGB population variances across production-jitter phases 0 through 31',
    };
  })()`);
  const afterExposure = await devTools.evaluate('window.renderLab.exposureFactor()');
  if (Math.abs(afterExposure - exposure) > Math.max(1, Math.abs(exposure)) * 1e-7) {
    throw new Error(`exposure changed during ${scene.name}/${candidate.label}`);
  }
  const result = 'window.__ssdBlind.result';
  for (const view of ['first', 'second', 'mean']) {
    const data = await correctionPng(devTools, `${result}.${view}`, CORRECTION_DISPLAY.gpu);
    writeImage(candidate.stimulusId, view, data);
  }
  const pngSaturatedPixelFractions = {};
  for (const view of ['deviation0', 'deviation1', 'variance']) {
    const { dataUrl, saturatedFraction } = await spreadPng(devTools, view);
    writeImage(candidate.stimulusId, view, dataUrl);
    pngSaturatedPixelFractions[view] = saturatedFraction;
  }
  for (const [view, source] of [
    ['clay-production', 'window.__ssd18Production'],
    ['clay-first', `${result}.first`],
    ['clay-mean', `${result}.mean`],
  ]) {
    const data = await devTools.evaluate(`(async () => {
      const base = window.__ssd18Base, source = ${source}, rgba = new Float32Array(${WIDTH * HEIGHT * 4});
      for (let p = 0; p < ${WIDTH * HEIGHT}; p++) {
        for (let c = 0; c < 3; c++) rgba[p * 4 + c] = Math.max(0, base[p * 3 + c] + source[p * 3 + c]);
        rgba[p * 4 + 3] = 1;
      }
      const display = await window.renderLab.composite({ width: ${WIDTH}, height: ${HEIGHT}, rgba });
      const canvas = document.createElement('canvas'); canvas.width = ${WIDTH}; canvas.height = ${HEIGHT};
      const ctx = canvas.getContext('2d', { alpha: false }), image = ctx.createImageData(${WIDTH}, ${HEIGHT});
      for (let i = 0; i < image.data.length; i++) image.data[i] = i % 4 === 3 ? 255
        : Math.round(255 * Math.max(0, Math.min(1, display.rgba[i])));
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    })()`);
    writeImage(candidate.stimulusId, view, data);
  }
  await devTools.evaluate('delete window.__ssdBlind; delete window.__ssd18Base; delete window.__ssd18Production');
  return {
    exposure,
    noiseProvenance: {
      production: { source: 'full-render', historyCap: 1 },
      stats: { source: captureProvenance.provenance, frameIndices: captureProvenance.frameIndices, groupCount: captureProvenance.groupCount },
    },
    productionPhase0Comparison,
    ...varianceStats, pngSaturatedPixelFractions, capturedAt: new Date().toISOString(),
  };
}

function roundOrders(candidates) {
  return [candidates, [...candidates].reverse(), [...candidates.slice(1), candidates[0]]];
}

async function measureCandidate(devTools, candidate) {
  await setCandidate(devTools, candidate);
  const result = await devTools.evaluate(`window.renderLab.measureCurrent(6, 30)`);
  if (!result.gpuSupported) throw new Error('GPU timestamp queries unavailable');
  const rows = Object.fromEntries(Object.entries(result.gpuPassMsById).map(([id, values]) => [id, values.p50]));
  const diffuseMs = SCREEN_SPACE_IDS.reduce((sum, id) => sum + (rows[id] ?? 0), 0);
  const materialMs = rows[MATERIAL_ID];
  if (!Number.isFinite(materialMs) || materialMs <= 0) throw new Error('material GPU row unavailable');
  return { rows, diffuseMs, materialMs, diffuseToMaterialRatio: diffuseMs / materialMs, measuredAt: new Date().toISOString() };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function withScene(scene, work) {
  const session = await openChromeSession({
    serveDir: BUILD_DIR, port: PORT, debugPort: DEBUG_PORT, profilePrefix: 'tepui-render-lab-ssd18a3-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"')) break;
      await sleep(200);
    }
    if (!(await devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"'))) throw new Error('render-lab API unavailable');
    const first = scene.candidates[0];
    await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shotName)}, ${JSON.stringify(candidateGraphics(first))})`);
    await devTools.evaluate(`window.renderLab.setRenderSize(${WIDTH}, ${HEIGHT});
      window.renderLab.setTarget("off")`);
    const actualCanvasSize = await devTools.evaluate(`(() => {
      const canvas = document.getElementById('view');
      return canvas ? {
        width: canvas.width, height: canvas.height,
        clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight,
      } : null;
    })()`);
    if (actualCanvasSize?.width !== WIDTH || actualCanvasSize?.height !== HEIGHT
      || actualCanvasSize?.clientWidth !== WIDTH || actualCanvasSize?.clientHeight !== HEIGHT) {
      throw new Error(`render canvas size mismatch: expected backing/client ${WIDTH}x${HEIGHT}, got ${actualCanvasSize?.width ?? 'missing'}x${actualCanvasSize?.height ?? 'missing'} backing, ${actualCanvasSize?.clientWidth ?? 'missing'}x${actualCanvasSize?.clientHeight ?? 'missing'} client`);
    }
    const exposure = await stabilizeExposure(devTools);
    return await work(devTools, { pageUrl: session.baseUrl, exposure, canvas: actualCanvasSize });
  } finally {
    await session.close();
  }
}

function writeViewer(key) {
  const availableScenes = key.scenes.filter(({ candidates }) => candidates.every(({ stimulusId }) =>
    VIEWS.every((view) => existsSync(imageFile(stimulusId, view)))));
  if (availableScenes.length === 0) return;
  const images = availableScenes.flatMap(({ candidates }) => candidates.flatMap(({ stimulusId }) => VIEWS
    .filter((view) => existsSync(imageFile(stimulusId, view)))
    .map((view) => ({ stimulusId, view, path: `images/${stimulusId}/${view}.png` }))));
  const data = {
    notePrefix: `ssd18-a3-blind-v1/${key.ratingNamespace}/`,
    scenes: availableScenes.map(({ scene }) => scene),
    labels: availableScenes[0].candidates.map(({ label }) => label),
    views: VIEWS, referenceViews: [], viewLabels: VIEW_LABELS,
    assignments: availableScenes.map(({ scene, candidates }) => ({
      scene, candidates: candidates.map(({ label, stimulusId }) => ({ label, stimulusId })), reference: null,
    })),
    images,
  };
  writeJson(path.join(OUTPUT, 'viewer-data.json'), data);
  const html = readFileSync(VIEWER_TEMPLATE, 'utf8').replace('__VIEWER_DATA__', () => JSON.stringify(data).replaceAll('<', '\\u003c'));
  writeFileSync(path.join(OUTPUT, 'index.html'), html);
}

async function produce() {
  await measureOnly();
  await captureOnly();
}

function selectedSceneRecords(key) {
  const requested = process.argv.find((arg) => arg.startsWith('--scene='))?.slice('--scene='.length);
  const selected = key.scenes.filter(({ scene }) => requested === undefined || scene === requested);
  if (selected.length === 0) throw new Error(`unknown scene ${requested}`);
  return selected;
}

function selectedCaptureRecords(key) {
  const selected = selectedSceneRecords(key);
  const candidateName = process.argv.find((arg) => arg.startsWith('--candidate='))?.slice('--candidate='.length);
  if (candidateName === undefined) return { selected, candidateOnly: false };
  if (!process.argv.some((arg) => arg.startsWith('--scene=')) || selected.length !== 1) {
    throw new Error('--candidate requires exactly one explicit --scene=<name>');
  }
  const candidate = selected[0].candidates.find(({ name }) => name === candidateName);
  if (!candidate) throw new Error(`unknown candidate ${candidateName} for ${selected[0].scene}`);
  return { selected: [{ ...selected[0], candidates: [candidate] }], candidateOnly: true };
}

async function measureOnly() {
  const key = loadKey();
  const selected = selectedSceneRecords(key);
  const saved = readJson(TIMINGS_FILE, null);
  const timings = saved?.keySeed === key.randomizationSeed && saved.scenes && typeof saved.scenes === 'object'
    ? saved
    : { keySeed: key.randomizationSeed, scenes: {} };
  timings.complete = false;
  delete timings.completedAt;
  timings.selectedScenes = selected.map(({ scene }) => scene);
  timings.startedAt ??= new Date().toISOString();
  timings.scenes ??= {};
  writeJson(TIMINGS_FILE, timings);
  for (const sceneRecord of selected) {
    const scene = key.config.scenes.find(({ name }) => name === sceneRecord.scene);
    const candidates = sceneRecord.candidates;
    await withScene({ ...scene, candidates }, async (devTools, session) => {
      const startedAt = new Date().toISOString();
      const timingRounds = [];
      timings.scenes[sceneRecord.scene] = {
        session: { pageUrl: session.pageUrl, exposure: session.exposure },
        startedAt, rounds: timingRounds, finishedAt: null,
      };
      writeJson(TIMINGS_FILE, timings);
      for (const [roundIndex, order] of roundOrders(candidates).entries()) {
        const round = { round: roundIndex + 1, order: order.map(({ label }) => label), measurements: [] };
        for (const candidate of order) {
          round.measurements.push({ label: candidate.label, ...(await measureCandidate(devTools, candidate)) });
        }
        timingRounds.push(round);
        writeJson(TIMINGS_FILE, timings);
      }
      const medianByLabel = {};
      for (const candidate of candidates) {
        const samples = timingRounds.flatMap(({ measurements }) => measurements.filter(({ label }) => label === candidate.label));
        const diffuseMedian = median(samples.map(({ diffuseMs }) => diffuseMs));
        const materialMedian = median(samples.map(({ materialMs }) => materialMs));
        medianByLabel[candidate.label] = {
          diffuseMsP50Median: diffuseMedian, materialMsP50Median: materialMedian,
          diffuseToMaterialRatioMedian: median(samples.map(({ diffuseToMaterialRatio }) => diffuseToMaterialRatio)),
        };
      }
      timings.scenes[sceneRecord.scene] = {
        ...timings.scenes[sceneRecord.scene],
        p50Median: medianByLabel, finishedAt: new Date().toISOString(), rounds: timingRounds,
      };
      writeJson(TIMINGS_FILE, timings);
    });
  }
  const allScenesRecorded = key.scenes.every(({ scene, candidates }) => {
    const record = timings.scenes[scene];
    return record?.finishedAt && candidates.every(({ label }) => record.p50Median?.[label]);
  });
  timings.complete = allScenesRecorded;
  if (allScenesRecorded) timings.completedAt = new Date().toISOString();
  writeJson(TIMINGS_FILE, timings);
}

function requireCompleteTimings(key, selected) {
  const timings = readJson(TIMINGS_FILE, null);
  if (!timings || timings.complete !== true || timings.keySeed !== key.randomizationSeed) {
    throw new Error('capture-only requires a completed timings.json for this exact key; run --measure-only first');
  }
  for (const { scene, candidates } of selected) {
    const record = timings.scenes?.[scene];
    if (!record?.finishedAt || candidates.some(({ label }) => !record.p50Median?.[label])) {
      throw new Error(`timings.json is incomplete for ${scene}`);
    }
  }
}

async function captureOnly() {
  const key = loadKey();
  const { selected, candidateOnly } = selectedCaptureRecords(key);
  requireCompleteTimings(key, selected);
  if (!candidateOnly) {
    for (const file of ['index.html', 'viewer-data.json']) {
      const publicFile = path.join(OUTPUT, file);
      if (existsSync(publicFile)) unlinkSync(publicFile);
    }
  }
  const records = readJson(RECORDS_FILE, { scenes: {} });
  mkdirSync(IMAGES, { recursive: true });
  for (const sceneRecord of selected) {
    const scene = key.config.scenes.find(({ name }) => name === sceneRecord.scene);
    const candidates = sceneRecord.candidates;
    await withScene({ ...scene, candidates }, async (devTools) => {
      for (const candidate of candidates) {
        records.scenes[sceneRecord.scene] ??= { candidates: {} };
        records.scenes[sceneRecord.scene].candidates[candidate.stimulusId] = await captureCandidate(devTools, scene, candidate);
        writeJson(RECORDS_FILE, records);
      }
    });
  }
  if (!candidateOnly) writeViewer(key);
}

const keyIndex = process.argv.indexOf('--make-key');
if (keyIndex >= 0) {
  const configArgument = process.argv[keyIndex + 1];
  const configFile = configArgument && !configArgument.startsWith('--')
    ? path.resolve(configArgument) : TRACKED_CONFIG_FILE;
  makeKey(configFile, process.argv.includes('--replace-key'));
}
else if (process.argv.includes('--measure-only') && process.argv.includes('--capture-only')) {
  throw new Error('choose only one of --measure-only or --capture-only');
} else if (process.argv.includes('--measure-only')) await measureOnly();
else if (process.argv.includes('--capture-only')) await captureOnly();
else await produce();
