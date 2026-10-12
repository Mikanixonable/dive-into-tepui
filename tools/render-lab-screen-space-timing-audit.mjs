import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';
import { seedOf } from './screen-space-lab.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.join(root, '.render-lab-shots', 'ssd-8-blind', 'work');
const sceneId = process.argv.find((arg) => arg.startsWith('--scene='))?.slice('--scene='.length) ?? 'bay-dark';
const budgetName = process.argv.find((arg) => arg.startsWith('--budget='))?.slice('--budget='.length) ?? 'medium';
const selectedVariants = process.argv.find((arg) => arg.startsWith('--variants='))?.slice('--variants='.length)
  .split(',').filter(Boolean);
const sceneById = {
  'bay-dark': { caseName: 'bay', shotName: 'bay-dark' },
  'bay-earth-open': { caseName: 'bay', shotName: 'bay-earth-open' },
  'cornell-box': { caseName: 'cornell-box', shotName: 'cornell-box' },
};
const budgets = {
  low: {
    band: { slices: 16, paths: 1 }, q: { slices: 20, paths: 1 },
    'raw-quarter': { slices: 22, paths: 1 }, 'raw-full': { slices: 1, paths: 1 },
  },
  medium: {
    band: { slices: 6, paths: 2 }, q: { slices: 8, paths: 2 },
    'raw-quarter': { slices: 9, paths: 2 }, 'raw-full': { slices: 2, paths: 1 },
  },
  high: {
    band: { slices: 7, paths: 4 }, q: { slices: 9, paths: 4 },
    'raw-quarter': { slices: 11, paths: 4 }, 'raw-full': { slices: 4, paths: 1 },
  },
};
const scene = sceneById[sceneId];
const budget = budgets[budgetName];
if (scene === undefined || budget === undefined) throw new Error(`unknown scene/budget: ${sceneId}/${budgetName}`);
const variants = selectedVariants ?? ['band', 'q', 'raw-quarter', 'raw-full'];
if (variants.some((variant) => !['band', 'q', 'raw-quarter', 'raw-full'].includes(variant))) {
  throw new Error(`unknown variant: ${variants.join(',')}`);
}
const outputPath = path.join(outputDir, `recheck-${sceneId}-${budgetName}-${variants.join('-')}.json`);
const rounds = [];
const output = { scene: sceneId, budget: budgetName, rounds, startedAt: new Date().toISOString() };

function save() {
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
}
function tierOf(variant, slices) {
  return { scale: variant === 'raw-full' ? 1 : 0.25, sliceCount: slices, stepCount: 5,
    bandCount: variant === 'band' ? 4 : 1, bandScale: 0.75 };
}
function rotate(values, n) {
  const k = n % values.length;
  return [...values.slice(k), ...values.slice(0, k)];
}
async function stabilizeExposure(devTools) {
  const values = await devTools.evaluate(`(async()=>{
    const values=[];
    for(let frame=0;frame<8;frame++){
      window.renderLab.render();values.push(window.renderLab.exposureFactor());
      if(values.length>=2){const a=values.at(-2),b=values.at(-1);if(Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-7)return values;}
      await new Promise(requestAnimationFrame);
    }
    return values;
  })()`);
  if (values.length < 2 || Math.abs(values.at(-1) - values.at(-2)) > Math.max(1, Math.abs(values.at(-1))) * 1e-7) {
    throw new Error(`exposure did not stabilize: ${JSON.stringify(values)}`);
  }
  return { frames: values, factor: values.at(-1) };
}

execFileSync(process.execPath, ['node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production'],
  { cwd: root, stdio: 'inherit' });
mkdirSync(outputDir, { recursive: true });
const session = await openChromeSession({ serveDir: path.join(root, '.render-lab'), port: 8793, debugPort: 9470,
  profilePrefix: 'tepui-render-lab-ssd8-timing-audit-' });
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  for (let i = 0; i < 600; i++) {
    if (await devTools.evaluate('typeof window.renderLab?.measureScreenSpacePaths === "function"')) break;
    await sleep(200);
  }
  await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)},${JSON.stringify(scene.shotName)})`);
  await devTools.evaluate('window.renderLab.setTarget("off");window.renderLab.setGraphicsOption("screenSpaceOcclusion",true);window.renderLab.setGraphicsOption("screenSpaceIndirect",true);window.renderLab.setGraphicsOption("screenSpaceSliceCount",4);window.renderLab.setGraphicsOption("screenSpaceStepCount",6);window.renderLab.setScanWhiteNoisePass(null)');
  output.adapter = await devTools.evaluate(`(async()=>{const a=await navigator.gpu.requestAdapter(),i=a.info??{};return [i.vendor,i.architecture,i.device,i.description].filter(Boolean).join(" / ")})()`);
  output.exposureStability = await stabilizeExposure(devTools);
  output.pageUrl = session.baseUrl;
  output.recheckedAt = new Date().toISOString();
  save();
  for (let round = 0; round < 3; round++) {
    const order = rotate(variants, round);
    const result = { round: round + 1, order, measurements: [], startedAt: new Date().toISOString() };
    rounds.push(result);
    for (const variant of order) {
      const config = budget[variant];
      await devTools.evaluate('window.renderLab.setScanWhiteNoisePass(null)');
      await devTools.evaluate(`window.renderLab.setScreenSpaceExperiment(${JSON.stringify(variant)},${JSON.stringify(tierOf(variant, config.slices))},8)`);
      const seeds = Array.from({ length: config.paths }, (_, p) => seedOf(p));
      await devTools.evaluate(`window.renderLab.setScanSeed(${seeds[0][0]},${seeds[0][1]})`);
      const measurement = config.paths === 1
        ? await devTools.evaluate('window.renderLab.measureCurrent(3,8)')
        : await devTools.evaluate(`window.renderLab.measureScreenSpacePaths(${JSON.stringify(seeds)},8)`);
      if (!measurement.gpuSupported) throw new Error('GPU timestamp queries unavailable');
      const rows = Object.fromEntries(Object.entries(measurement.gpuPassMsById)
        .filter(([id]) => id.startsWith('nearbyDiffuse')).map(([id, value]) => [id, value]));
      const p50Rows = Object.fromEntries(Object.entries(rows).map(([id, value]) => [id, value.p50]));
      result.measurements.push({ variant, slices: config.slices, paths: config.paths, rows, p50Rows,
        totalP50Ms: Object.values(p50Rows).reduce((sum, value) => sum + value, 0) });
      result.recordedAt = new Date().toISOString();
      save();
      console.log(`Timing recheck round ${round + 1}: ${variant}`);
    }
  }
  output.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ scene: output.scene, budget: output.budget, exposureStability: output.exposureStability,
    rounds: rounds.length, finishedAt: output.finishedAt }));
} finally {
  await session.close();
}
