// 手順18-a3の steps != 5 候補を、元設定と steps=5 の対照で独立撮影する。
// GPU 撮影は既存の private key と render-lab の公開 API を使い、blind gallery へ書き込まない。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';
import {
  CORRECTION_DISPLAY, captureProductionPhases, correctionPng, stabilizeExposure,
} from './screen-space-blind-capture.mjs';
import { shotsDir, WIDTH, HEIGHT } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, '.render-lab');
const WORK = path.join(shotsDir, 'ssd-18-a3-work');
const KEY_FILE = path.join(WORK, 'keys', 'key.json');
const OUTPUT = path.join(WORK, 'steps-control');
const PORT = 8787;
const DEBUG_PORT = 9463;
const GRAPHICS_KEYS = [
  'screenSpaceOcclusion', 'screenSpaceIndirect', 'screenSpaceScanScale', 'screenSpaceBandCount',
  'screenSpaceSliceCount', 'screenSpaceStepCount', 'screenSpaceDirectionalPlanetCount',
  'screenSpaceHistoryCap', 'screenSpaceUpsampleTapCount',
];
const SHOW_GRAPHICS = {
  screenSpaceSpecular: true,
  screenSpaceSpecularScale: 0.5,
  screenSpaceSpecularStepCount: 32,
  screenSpaceSpecularDenoise: false,
};
const SCENES = [
  { name: 'bay-truss', caseName: 'bay', shotName: 'bay-truss' },
  { name: 'bay-edge', caseName: 'bay', shotName: 'bay-edge' },
  { name: 'groove-ladder', caseName: 'groove-ladder', shotName: 'groove-ladder' },
];
const pngBytes = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const imagePath = (candidate, scene, side, view) =>
  path.join(OUTPUT, candidate.name, scene.name, side, `${view}.png`);

function readCandidates() {
  if (!existsSync(KEY_FILE)) throw new Error(`private key missing: ${KEY_FILE}`);
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const common = key.scenes[0]?.candidates;
  if (!Array.isArray(common) || key.scenes.length !== 5
    || key.scenes.some(({ candidates }) => JSON.stringify(candidates.map(({ name }) => name))
      !== JSON.stringify(common.map(({ name }) => name)))) {
    throw new Error('private key must contain the same candidate order in all five scenes');
  }
  const candidates = common.filter(({ graphics }) => graphics.screenSpaceStepCount !== 5);
  if (candidates.length !== 8 || candidates.some(({ graphics }) => graphics.screenSpaceHistoryCap !== 1)) {
    throw new Error(`expected eight non-five-step candidates with s=1; found ${candidates.length}`);
  }
  return candidates;
}

async function setCandidate(devTools, candidate, stepCount) {
  for (const key of GRAPHICS_KEYS) {
    const value = key === 'screenSpaceStepCount' ? stepCount : candidate.graphics[key];
    await devTools.evaluate(`window.renderLab.setGraphicsOption(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  }
}

async function captureSide(devTools, candidate, scene, side, stepCount) {
  await setCandidate(devTools, candidate, stepCount);
  await devTools.evaluate('window.renderLab.renderProductionCorrectionPhase(0)');
  await devTools.evaluate(`window.renderLab.readFloat('upsampled-correction').then(({ rgba }) => {
    const rgb = new Float32Array(${WIDTH * HEIGHT * 3});
    for (let p = 0, i = 0; p < ${WIDTH * HEIGHT}; p++, i += 3) {
      rgb[i] = rgba[p * 4]; rgb[i + 1] = rgba[p * 4 + 1]; rgb[i + 2] = rgba[p * 4 + 2];
    }
    window.__ssdStepsOnePass = rgb;
  })`);
  const onePass = await correctionPng(
    devTools, 'window.__ssdStepsOnePass', CORRECTION_DISPLAY.gpu, 1,
  );
  const onePassFile = imagePath(candidate, scene, side, 'one-pass');
  mkdirSync(path.dirname(onePassFile), { recursive: true });
  writeFileSync(onePassFile, pngBytes(onePass));
  await devTools.evaluate('delete window.__ssdStepsOnePass');

  await captureProductionPhases(devTools, `${candidate.name}/${scene.name}/${side}`);
  const mean = await correctionPng(
    devTools, 'window.__ssdBlind.result.mean', CORRECTION_DISPLAY.gpu, 1,
  );
  const meanFile = imagePath(candidate, scene, side, 'mean-32');
  writeFileSync(meanFile, pngBytes(mean));
  await devTools.evaluate('delete window.__ssdBlind');
}

async function withScene(scene, candidates, work) {
  const session = await openChromeSession({
    serveDir: BUILD_DIR, port: PORT, debugPort: DEBUG_PORT, profilePrefix: 'tepui-render-lab-steps18a3-',
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await devTools.evaluate('typeof window.renderLab?.showShot === "function"')) break;
      await sleep(200);
    }
    if (!(await devTools.evaluate('typeof window.renderLab?.showShot === "function"'))) {
      throw new Error('render-lab API unavailable');
    }
    const first = candidates[0];
    await devTools.evaluate(`window.renderLab.showShot(${JSON.stringify(scene.caseName)}, ${JSON.stringify(scene.shotName)}, ${JSON.stringify({ ...SHOW_GRAPHICS, ...first.graphics })})`);
    await devTools.evaluate(`window.renderLab.setRenderSize(${WIDTH}, ${HEIGHT});
      window.renderLab.setTarget("off")`);
    const canvas = await devTools.evaluate(`(() => {
      const element = document.getElementById('view');
      return element ? { width: element.width, height: element.height,
        clientWidth: element.clientWidth, clientHeight: element.clientHeight } : null;
    })()`);
    if (canvas?.width !== WIDTH || canvas?.height !== HEIGHT
      || canvas?.clientWidth !== WIDTH || canvas?.clientHeight !== HEIGHT) {
      throw new Error(`canvas backing/client size must be ${WIDTH}x${HEIGHT}: ${JSON.stringify(canvas)}`);
    }
    await stabilizeExposure(devTools);
    await work(devTools);
  } finally {
    await session.close();
  }
}

function writeIndex(candidates) {
  const sections = candidates.map((candidate) => {
    const scenes = SCENES.map((scene) => {
      const image = (side, view, alt) => `![${alt}](<${candidate.name}/${scene.name}/${side}/${view}.png>)`;
      return `### ${scene.name}\n\n| 元設定 位相0 | 元設定 本番ジッター32フレーム平均 | steps=5 位相0 | steps=5 本番ジッター32フレーム平均 |\n|---|---|---|---|\n| ${image('original', 'one-pass', `${candidate.name} ${scene.name} original phase 0`)} | ${image('original', 'mean-32', `${candidate.name} ${scene.name} original production jitter mean`)} | ${image('steps-5', 'one-pass', `${candidate.name} ${scene.name} steps 5 phase 0`)} | ${image('steps-5', 'mean-32', `${candidate.name} ${scene.name} steps 5 production jitter mean`)} |`;
    }).join('\n\n');
    return `## ${candidate.name} (${candidate.budget})\n\n元設定: \`${JSON.stringify(candidate.graphics)}\`\n\n${scenes}`;
  }).join('\n\n---\n\n');
  const markdown = `# 18-a3 steps control\n\n各候補の元設定と steps=5 を比較。1枚目は本番フレームジッター位相0の補正。32フレーム平均は本番フレームジッター位相0〜31から作り、元設定とsteps=5の両側に同じ位相列を使う。s=1、specular=true、scale=0.5、steps=32、denoise=false。\n\n${sections}\n`;
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(path.join(OUTPUT, 'index.md'), markdown);
}

const candidates = readCandidates();
for (const scene of SCENES) {
  await withScene(scene, candidates, async (devTools) => {
    for (const candidate of candidates) {
      await captureSide(devTools, candidate, scene, 'original', candidate.graphics.screenSpaceStepCount);
      await captureSide(devTools, candidate, scene, 'steps-5', 5);
    }
  });
}
writeIndex(candidates);
console.log(`private steps-control images and index written under ${OUTPUT}`);
