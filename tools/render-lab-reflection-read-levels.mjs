// 映り込みの読む段ごとに収束像と 1 パス雑音を撮影する。
// 使い方: node tools/render-lab-reflection-read-levels.mjs --run=<label> [--scene=<key>]
// [--passes=1024] [--level-passes=256] [--graphics=<JSON>]
// .render-lab のビルドを配信するだけなので、先に npx webpack --config webpack.render-lab.config.js --mode production を走らせる。
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HEIGHT, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';
import {
  BASE_GRAPHICS, GRID, ONE_PASS, SCENES, argumentOf, graphicsOf, logStep, meanImage, qImage, readImage, seedsOf,
  takeReflectionSums,
} from './reflection-chain-common.mjs';

const OUTPUT = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-read-levels', 'runs');
const LABEL = argumentOf('run');
const SCENE_ARG = argumentOf('scene');
const PASSES = Number(argumentOf('passes') ?? 1024);
const LEVEL_PASSES = Number(argumentOf('level-passes') ?? 256);
const PRODUCTION_ONLY = process.argv.includes('--production-only');
const GRAPHICS = { ...graphicsOf(argumentOf('graphics')), ...BASE_GRAPHICS };
const selectedScenes = SCENE_ARG === undefined ? SCENES : SCENES.filter(({ key }) => key === SCENE_ARG);
const seeds = seedsOf();
const onePassSeeds = seeds.slice(GRID * GRID - ONE_PASS);
if (LABEL === undefined || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(LABEL)) throw new Error('missing or invalid --run');
if (!Number.isInteger(PASSES) || PASSES < 1 || PASSES > GRID * GRID) throw new Error('--passes must be 1..4096');
if (!Number.isInteger(LEVEL_PASSES) || LEVEL_PASSES < 1 || LEVEL_PASSES > GRID * GRID) {
  throw new Error('--level-passes must be 1..4096');
}
if (selectedScenes.length === 0) throw new Error(`unknown scene: ${SCENE_ARG}`);

await withLab(async (_lab, devTools) => {
  const runDir = path.join(OUTPUT, LABEL);
  mkdirSync(runDir, { recursive: true });
  for (const scene of selectedScenes) await captureScene(devTools, scene, runDir);
  const indexTool = path.join(path.resolve(import.meta.dirname), 'reflection-read-level-index.mjs');
  execSync(`node "${indexTool}"`, { stdio: 'inherit' });
});

async function captureScene(devTools, scene, runDir) {
  const dir = path.join(runDir, scene.key);
  mkdirSync(dir, { recursive: true });
  const showShot = `window.renderLab.showShot(${JSON.stringify(scene.caseName)}, `
    + `${JSON.stringify(scene.shot)}, ${JSON.stringify(GRAPHICS)})`;
  await devTools.evaluate(showShot);
  for (const [key, value] of Object.entries(GRAPHICS)) {
    await devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }
  await devTools.evaluate('window.renderLab.setTarget("off"); window.renderLab.setReflectionFixedLevel(null)');
  logStep(scene.key, 'repeat check');
  const baseline = await baselineOf(devTools);
  if (baseline.maximum !== 0) throw new Error(`${scene.key}: repeated seed differs by ${baseline.maximum}`);

  const exposure = await devTools.evaluate('window.renderLab.exposureFactor()');
  const far = await readImage(devTools, 'far-specular');
  logStep(scene.key, 'production accumulation');
  const sums = await takeReflectionSums(devTools, seeds.slice(0, PASSES));
  const rawMean = meanParity(sums, 0, PASSES);
  const productionMean = meanParity(sums, 1, PASSES);
  const qBase = qImage(rawMean, far, exposure);
  const qProduction = qImage(productionMean, far, exposure);
  writeFloats(path.join(dir, 'q-b.f32'), qBase);
  writeFloats(path.join(dir, 'q-production.f32'), qProduction);

  logStep(scene.key, 'one pass samples');
  const sampleRaw = [], sampleProduction = [], levelMaps = [];
  for (const [x, y] of onePassSeeds.slice(0, ONE_PASS)) {
    await devTools.evaluate(`window.renderLab.renderReflectionPass(${x}, ${y})`);
    const raw = qImage(await readImage(devTools, 'reflection-raw'), far, exposure);
    const production = qImage(await readImage(devTools, 'reflection-denoised'), far, exposure);
    const encoded = await readImage(devTools, 'reflection-level');
    sampleRaw.push(raw);
    sampleProduction.push(production);
    const levels = new Float32Array(WIDTH * HEIGHT);
    for (let p = 0; p < levels.length; p++) {
      const code = encoded.rgba[p * 4];
      const level = code > 1 ? code - 2 : -1;
      levels[p] = level;
    }
    levelMaps.push(levels);
  }
  for (let index = 0; index < ONE_PASS; index++) {
    writeFloats(path.join(dir, `sample-L0-s${index}.f32`), sampleRaw[index]);
    writeFloats(path.join(dir, `sample-production-s${index}.f32`), sampleProduction[index]);
  }
  for (let index = 0; index < ONE_PASS; index++) writeFloats(path.join(dir, `level-production-s${index}.f32`), levelMaps[index]);

  const levelCount = GRAPHICS.screenSpaceSpecularDenoiseLevelCount ?? 7;
  const lmax = Math.floor(levelCount - 1 + Math.log2(HEIGHT / 540));
  for (let level = 1; level <= (PRODUCTION_ONLY ? 0 : lmax); level++) {
    logStep(scene.key, `fixed level ${level}`);
    await devTools.evaluate(`window.renderLab.setReflectionFixedLevel(${level})`);
    const levelSums = await takeReflectionSums(devTools, seeds.slice(0, LEVEL_PASSES));
    const levelMean = meanParity(levelSums, 1, LEVEL_PASSES);
    const qLevel = qImage(levelMean, far, exposure);
    writeFloats(path.join(dir, `q-L${level}.f32`), qLevel);
    for (let index = 0; index < ONE_PASS; index++) {
      const [x, y] = onePassSeeds[index];
      await devTools.evaluate(`window.renderLab.renderReflectionPass(${x}, ${y})`);
      const sample = qImage(await readImage(devTools, 'reflection-denoised'), far, exposure);
      writeFloats(path.join(dir, `sample-L${level}-s${index}.f32`), sample);
    }
  }

  await devTools.evaluate('window.renderLab.setReflectionFixedLevel(null)');
  await devTools.evaluate('window.renderLab.renderReflectionPass(0, 0)');
  const finalBaseline = await baselineOf(devTools);
  if (finalBaseline.maximum !== 0
      || maximumDifference(finalBaseline.raw.rgba, baseline.raw.rgba) !== 0
      || maximumDifference(finalBaseline.production.rgba, baseline.production.rgba) !== 0) {
    throw new Error(`${scene.key}: reset pass differs from baseline`);
  }
  for (const name of ['gbuffer-normal', 'gbuffer-roughness', 'depth']) {
    const image = await readImage(devTools, name);
    const filename = name === 'gbuffer-normal' ? 'normal.f32'
      : name === 'gbuffer-roughness' ? 'roughness.f32' : 'depth.f32';
    writeFloats(path.join(dir, filename), image.rgba);
  }
  const metadata = { lmax, productionOnly: PRODUCTION_ONLY, passes: PASSES, levelPasses: LEVEL_PASSES,
    exposure, commit: execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(), graphics: GRAPHICS };
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(metadata, null, 2));
}

async function baselineOf(devTools) {
  await devTools.evaluate('window.renderLab.renderReflectionPass(0, 0)');
  const raw = await readImage(devTools, 'reflection-raw');
  const production = await readImage(devTools, 'reflection-denoised');
  await devTools.evaluate('window.renderLab.renderReflectionPass(0, 0)');
  const repeatedRaw = await readImage(devTools, 'reflection-raw');
  const repeatedProduction = await readImage(devTools, 'reflection-denoised');
  return {
    maximum: Math.max(maximumDifference(raw.rgba, repeatedRaw.rgba),
      maximumDifference(production.rgba, repeatedProduction.rgba)),
    raw,
    production,
  };
}

function meanParity(sums, kind, count) {
  return meanImage(sums[0][kind], sums[1][kind], count);
}

function maximumDifference(a, b) {
  let maximum = 0;
  for (let index = 0; index < a.length; index++) maximum = Math.max(maximum, Math.abs(a[index] - b[index]));
  return maximum;
}

