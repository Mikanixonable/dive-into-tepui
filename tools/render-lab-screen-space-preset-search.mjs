// 近傍拡散補正のノブ感度の計測。設定ごとに、構図ごとのちらつき J と補正の大きさ M(本番ジッター位相 0〜31 の蓄積前の補正)と、
// bay-two-planets の GPU 費用比 R を測り、.render-lab-shots/ssd-18-a/sensitivity/ に表と画像を書く。
// 使い方: node tools/render-lab-screen-space-preset-search.mjs [設定.json] [--out=名前] [--rounds=N(3の倍数、省くと3)] [--no-build] [--time-only | --capture-only]
//
// 設定: { scenes: [{ name, caseName, shotName }], configs: [{ name, base, check?, graphics }] }
// graphics は screenSpaceOcclusion, screenSpaceIndirect, screenSpaceHistoryCap(=1) を含む近傍拡散補正の全ノブ。
// base は差分表の基点の設定名(基点自身は null)。check が真の設定では、位相 0 と通常描画の一致と、保存値からの J の再計算を検査する。
//
// 評価領域 Ω は構図ごとの projected-radius > 0 の画素(G バッファに面のある画素)。G バッファはノブに依らないので設定間で同じ。
// (読み戻しの 'depth' は読んだあとの描画が落ちるので使わない。)
// J = sqrt(Σ_{f,x∈Ω,c}(C_f − C̄)² / (32·|Ω|·3))、M = sqrt(Σ_{x∈Ω,c} C̄² / (|Ω|·3))。
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';
import { CORRECTION_DISPLAY, correctionPng, stabilizeExposure } from './screen-space-blind-capture.mjs';
import { HEIGHT, shotsDir, WIDTH } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, '.render-lab');
const roundCount = Number(process.argv.slice(2).find((arg) => arg.startsWith('--rounds='))?.slice('--rounds='.length) ?? 3);
const outName = process.argv.slice(2).find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ?? 'sensitivity';
const OUTPUT = path.join(shotsDir, 'ssd-18-a', outName);
const IMAGES = path.join(OUTPUT, 'images');
const CHECKS = path.join(OUTPUT, 'check');
const DEFAULT_CONFIG = path.join(ROOT, 'tools', 'render-lab-screen-space-preset-search-config.json');
const PORT = 8787;
const DEBUG_PORT = 9463;
const PHASE_COUNT = 32;
const TIMING_SCENE = 'bay-two-planets';
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
const BASE_GRAPHICS = {
  screenSpaceSpecular: true, screenSpaceSpecularScale: 0.5, screenSpaceSpecularStepCount: 32, screenSpaceSpecularDenoise: false,
};
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const configFile = args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_CONFIG;
const config = JSON.parse(readFileSync(configFile, 'utf8'));

const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const writePng = (file, dataUrl) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function validateConfig() {
  for (const { name, graphics } of config.configs) {
    if (GRAPHICS_KEYS.some((key) => !(key in graphics)) || Object.keys(graphics).length !== GRAPHICS_KEYS.length
      || graphics.screenSpaceOcclusion !== true || graphics.screenSpaceIndirect !== true || graphics.screenSpaceHistoryCap !== 1) {
      throw new Error(`${name}: graphics must hold every screen-space knob with occlusion, indirect, historyCap=1`);
    }
  }
}

async function withScene(scene, work) {
  const session = await openChromeSession({
    serveDir: BUILD_DIR, port: PORT, debugPort: DEBUG_PORT, profilePrefix: 'tepui-render-lab-preset-search-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"')) break;
      await sleep(200);
    }
    if (!(await devTools.evaluate('typeof window.renderLab?.measureCurrent === "function"'))) throw new Error('render-lab API unavailable');
    const first = { ...BASE_GRAPHICS, ...config.configs[0].graphics };
    await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shotName)}, ${JSON.stringify(first)})`);
    await devTools.evaluate(`window.renderLab.setRenderSize(${WIDTH}, ${HEIGHT}); window.renderLab.setTarget("off")`);
    const canvas = await devTools.evaluate(`(() => {
      const c = document.getElementById('view');
      return c && { width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight };
    })()`);
    if (canvas?.width !== WIDTH || canvas?.height !== HEIGHT || canvas?.clientWidth !== WIDTH || canvas?.clientHeight !== HEIGHT) {
      throw new Error(`render canvas size mismatch: expected ${WIDTH}x${HEIGHT}, got ${JSON.stringify(canvas)}`);
    }
    await stabilizeExposure(devTools);
    return await work(devTools);
  } finally {
    await session.close();
  }
}

async function setGraphics(devTools, graphics) {
  for (const key of GRAPHICS_KEYS) {
    await devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(graphics[key])})`);
  }
}

// ---- 計時 ----

async function measureConfig(devTools, { graphics }) {
  await setGraphics(devTools, graphics);
  const result = await devTools.evaluate('window.renderLab.measureCurrent(6, 30)');
  if (!result.gpuSupported) throw new Error('GPU timestamp queries unavailable');
  const p50 = (id) => result.gpuPassMsById[id]?.p50 ?? 0;
  const diffuseMs = SCREEN_SPACE_IDS.reduce((sum, id) => sum + p50(id), 0);
  const materialMs = p50(MATERIAL_ID);
  if (!(materialMs > 0)) throw new Error('material GPU row unavailable');
  return { diffuseMs, materialMs, ratio: diffuseMs / materialMs };
}

// 設定を順・逆・1つ回した順で roundCount 巡する(3順を繰り返す)。{ 設定名: { rounds: [R...], median } } を返す。
async function timeConfigs() {
  const scene = config.scenes.find(({ name }) => name === TIMING_SCENE);
  const { configs } = config;
  if (roundCount % 3 !== 0) throw new Error('--rounds must be a multiple of 3');
  const threeOrders = [configs, [...configs].reverse(), [...configs.slice(1), configs[0]]];
  const orders = Array.from({ length: roundCount }, (_, i) => threeOrders[i % 3]);
  const ratios = Object.fromEntries(configs.map(({ name }) => [name, []]));
  await withScene(scene, async (devTools) => {
    for (const [round, order] of orders.entries()) {
      console.log(`timing round ${round + 1}/${roundCount}`);
      for (const candidate of order) ratios[candidate.name].push((await measureConfig(devTools, candidate)).ratio);
    }
  });
  return Object.fromEntries(Object.entries(ratios).map(([name, rounds]) => [name, { rounds, median: median(rounds) }]));
}

// ---- 撮影 ----

// ページ側の器 window.__sspsTool。Ω と、位相ごとの補正の和・二乗和(倍精度)から J と M を出す。
const PAGE_TOOL = `window.__sspsTool = (() => {
  const n = ${WIDTH * HEIGHT};
  let omega = null, sum = null, squareSum = null, first = null;
  const omegaOf = (depth) => { const mask = new Uint8Array(n); for (let p = 0; p < n; p++) mask[p] = depth[p * 4] > 0 ? 1 : 0; return mask; };
  return {
    async begin() {
      omega = omegaOf((await window.renderLab.readFloat('projected-radius')).rgba);
      sum = new Float64Array(n * 3); squareSum = new Float64Array(n * 3); first = null;
      let count = 0, checksum = 0;
      for (let p = 0; p < n; p++) { count += omega[p]; checksum = (checksum * 31 + omega[p] * (p % 1013 + 1)) % 1000000007; }
      return { count, checksum };
    },
    async step(frame) {
      window.renderLab.renderProductionCorrectionPhase(frame);
      const { rgba } = await window.renderLab.readFloat('upsampled-correction');
      if (frame === 0) first = new Float32Array(n * 3);
      for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) {
        const v = rgba[p * 4 + c]; sum[p * 3 + c] += v; squareSum[p * 3 + c] += v * v;
        if (frame === 0) first[p * 3 + c] = v;
      }
    },
    finish(count) {
      const mean = new Float32Array(n * 3), variance = new Float32Array(n * 3);
      let varianceTotal = 0, meanSquareTotal = 0;
      for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) {
        const i = p * 3 + c, m = sum[i] / ${PHASE_COUNT}, v = Math.max(0, squareSum[i] / ${PHASE_COUNT} - m * m);
        mean[i] = m; variance[i] = v;
        if (omega[p]) { varianceTotal += v; meanSquareTotal += m * m; }
      }
      window.__sspsMean = mean; window.__sspsFirst = first; window.__sspsVariance = variance;
      return { J: Math.sqrt(varianceTotal / (count * 3)), M: Math.sqrt(meanSquareTotal / (count * 3)) };
    },
    byteLength(name) { return name === 'omega' ? omega.byteLength : n * 12; },
    bytes(name, from, to) {
      const array = name === 'omega' ? omega : name === 'mean' ? window.__sspsMean : window.__sspsVariance;
      const view = new Uint8Array(array.buffer, array.byteOffset + from, to - from);
      let text = '';
      for (let i = 0; i < view.length; i += 32768) text += String.fromCharCode(...view.subarray(i, i + 32768));
      return btoa(text);
    },
  };
})()`;

// 通常描画の補正と位相 0 の補正が全 RGB 要素で一致するかを数える。
async function comparePhase0(devTools) {
  await devTools.evaluate('window.renderLab.render()');
  await devTools.evaluate(`window.renderLab.readFloat('correction').then(({ rgba }) => { window.__sspsProduction = rgba; })`);
  await devTools.evaluate('window.renderLab.renderProductionCorrectionPhase(0)');
  const result = await devTools.evaluate(`window.renderLab.readFloat('upsampled-correction').then(({ rgba }) => {
    const production = window.__sspsProduction;
    let differentRgbValues = 0, maxAbsoluteDifference = 0, compared = 0;
    for (let p = 0; p < ${WIDTH * HEIGHT}; p++) for (let c = 0; c < 3; c++, compared++) {
      const d = Math.abs(production[p * 4 + c] - rgba[p * 4 + c]);
      if (d !== 0) differentRgbValues++;
      maxAbsoluteDifference = Math.max(maxAbsoluteDifference, d);
    }
    delete window.__sspsProduction;
    return { compared, differentRgbValues, maxAbsoluteDifference };
  })`);
  await devTools.evaluate('window.renderLab.renderProductionCorrectionPhase(null)');
  return result;
}

// ページ側の配列 name のバイト列を 1 MiB ずつ受け取ってファイルへ書く。
async function saveBytes(devTools, name, file) {
  const total = await devTools.evaluate(`window.__sspsTool.byteLength('${name}')`);
  const chunks = [];
  for (let from = 0; from < total; from += 1 << 20) {
    chunks.push(Buffer.from(await devTools.evaluate(`window.__sspsTool.bytes('${name}', ${from}, ${Math.min(total, from + (1 << 20))})`), 'base64'));
  }
  writeFileSync(file, Buffer.concat(chunks));
}

// 保存したファイル(Ω・C̄・分散)だけから J と M を計算し直す。
function recomputeFromSavedValues(directory) {
  const omega = readFileSync(path.join(directory, 'omega.u8'));
  const read = (name) => { const b = readFileSync(path.join(directory, name)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  const mean = read('mean.f32'), variance = read('variance.f32');
  let count = 0, varianceTotal = 0, meanSquareTotal = 0;
  for (let p = 0; p < omega.length; p++) {
    if (!omega[p]) continue;
    count++;
    for (let c = 0; c < 3; c++) { varianceTotal += variance[p * 3 + c]; meanSquareTotal += mean[p * 3 + c] ** 2; }
  }
  return { J: Math.sqrt(varianceTotal / (count * 3)), M: Math.sqrt(meanSquareTotal / (count * 3)), count };
}

async function captureConfig(devTools, scene, candidate, expected) {
  await setGraphics(devTools, candidate.graphics);
  await devTools.evaluate('window.renderLab.render()');
  const exposure = await devTools.evaluate('window.renderLab.exposureFactor()');
  const phase0Comparison = candidate.check ? await comparePhase0(devTools) : null;
  const omega = await devTools.evaluate('window.__sspsTool.begin()');
  if (expected.omega && (omega.count !== expected.omega.count || omega.checksum !== expected.omega.checksum)) {
    throw new Error(`${scene.name}/${candidate.name}: evaluation region differs between settings`);
  }
  try {
    for (let frame = 0; frame < PHASE_COUNT; frame++) await devTools.evaluate(`window.__sspsTool.step(${frame})`);
  } finally {
    await devTools.evaluate('window.renderLab.renderProductionCorrectionPhase(null)');
  }
  const { J, M } = await devTools.evaluate(`window.__sspsTool.finish(${omega.count})`);
  const imageDirectory = path.join(IMAGES, scene.name);
  writePng(path.join(imageDirectory, `${candidate.name}-mean.png`), await correctionPng(devTools, 'window.__sspsMean', CORRECTION_DISPLAY.gpu));
  writePng(path.join(imageDirectory, `${candidate.name}-phase0.png`), await correctionPng(devTools, 'window.__sspsFirst', CORRECTION_DISPLAY.gpu));
  let recomputation = null;
  if (candidate.check) {
    const directory = path.join(CHECKS, scene.name, candidate.name);
    mkdirSync(directory, { recursive: true });
    await saveBytes(devTools, 'omega', path.join(directory, 'omega.u8'));
    await saveBytes(devTools, 'mean', path.join(directory, 'mean.f32'));
    await saveBytes(devTools, 'variance', path.join(directory, 'variance.f32'));
    const saved = recomputeFromSavedValues(directory);
    recomputation = { J: saved.J, M: saved.M, count: saved.count, relativeJDifference: Math.abs(saved.J - J) / J, relativeMDifference: Math.abs(saved.M - M) / M };
    rmSync(directory, { recursive: true, force: true });
  }
  const afterExposure = await devTools.evaluate('window.renderLab.exposureFactor()');
  return {
    J, M, JOverM: J / M, omegaPixels: omega.count, omega, exposure, exposureChanged: afterExposure !== exposure,
    phase0Comparison, recomputation,
  };
}

async function captureScene(scene) {
  const results = {};
  await withScene(scene, async (devTools) => {
    await devTools.evaluate(PAGE_TOOL);
    const expected = {};
    for (const candidate of config.configs) {
      console.log(`capture ${scene.name}/${candidate.name}`);
      results[candidate.name] = await captureConfig(devTools, scene, candidate, expected);
      expected.omega ??= results[candidate.name].omega;
    }
  });
  return results;
}

// ---- 出力 ----

const fixed = (value, digits) => value.toFixed(digits);
const row = (cells) => `| ${cells.join(' | ')} |`;

function summaryOf(report, timeOnly) {
  const names = config.scenes.map(({ name }) => name);
  const bases = Object.fromEntries(config.configs.map(({ name, base }) => [name, base]));
  const lines = ['# 近傍拡散補正のノブ感度', '',
    `R = 近傍拡散の GPU 行 p50 の和 / material 行 p50(${TIMING_SCENE}、${roundCount}巡の中央値)。J = 位相 0〜31 のちらつき、M = 位相平均の補正の RMS(Ω 内、線形 RGB)。`, '',
  ];
  if (!timeOnly) lines.push('## 生の値', '',
    row(['設定', 'R', ...names.map((n) => `J ${n}`), ...names.map((n) => `M ${n}`)]),
    row(Array(2 + names.length * 2).fill('---')));
  for (const { name } of timeOnly ? [] : config.configs) {
    lines.push(row([name, fixed(report.R[name].median, 3),
      ...names.map((n) => fixed(report.scenes[n][name].J, 5)), ...names.map((n) => fixed(report.scenes[n][name].M, 5))]));
  }
  if (!timeOnly && config.configs.some(({ base }) => base !== null)) {
    lines.push('', '## 基点との差', '',
      row(['設定', '基点', 'ΔR', ...names.map((n) => `ΔJ/J_base ${n}`)]), row(Array(3 + names.length).fill('---')));
    for (const { name } of config.configs) {
      const base = bases[name];
      if (base === null) continue;
      lines.push(row([name, base, fixed(report.R[name].median - report.R[base].median, 3),
        ...names.map((n) => `${fixed(100 * (report.scenes[n][name].J / report.scenes[n][base].J - 1), 1)}%`)]));
    }
  }
  lines.push('', '## R の各巡(順・逆・回転)', '',
    row(['設定', ...Array.from({ length: roundCount }, (_, i) => `巡${i + 1}`), '中央値', '最小', '最大']), row(Array(roundCount + 4).fill('---')));
  for (const { name } of config.configs) {
    const { rounds, median: middle } = report.R[name];
    lines.push(row([name, ...rounds.map((v) => fixed(v, 3)), fixed(middle, 3), fixed(Math.min(...rounds), 3), fixed(Math.max(...rounds), 3)]));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  validateConfig();
  if (!flag('--no-build')) execSync('npx webpack --config webpack.render-lab.config.js --mode production', { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(path.join(BUILD_DIR, 'index.html'))) throw new Error('render-lab build missing');
  const started = Date.now();
  const R = flag('--capture-only') ? JSON.parse(readFileSync(path.join(OUTPUT, 'results.json'), 'utf8')).R : await timeConfigs();
  const scenes = {};
  if (!flag('--time-only')) for (const scene of config.scenes) scenes[scene.name] = await captureScene(scene);
  const report = {
    commit: execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(),
    width: WIDTH, height: HEIGHT, phaseCount: PHASE_COUNT, timingScene: TIMING_SCENE,
    elapsedSeconds: (Date.now() - started) / 1000, configs: config.configs, R, scenes,
  };
  writeJson(path.join(OUTPUT, 'results.json'), report);
  writeFileSync(path.join(OUTPUT, 'summary.md'), summaryOf(report, flag('--time-only')));
}

await main();
