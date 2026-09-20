// 6 regime を同じ cloud-lab の composite 経路で撮影し、time-warp の side-by-side review
// package を作る。画像の自動合否は行わず、manifest の humanReview を人が埋める。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng, encodeRgbaPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.cloud-lab');
const outDir = path.join(buildDir, 'visual-review');
const port = 8771;
const debugPort = 9448;
const VIEW = 'composite';
const SOURCE_WIDTH = 1536;
const SOURCE_HEIGHT = 512;
const REGIMES = [
  { id: 'trade-cumulus', label: 'trade cumulus', latitude: 10, longitude: 140, radius: 20 },
  { id: 'marine-stratocumulus', label: 'marine stratocumulus', latitude: -20, longitude: -85, radius: 20 },
  { id: 'temperate-front', label: 'temperate frontal cloud', latitude: 50, longitude: -30, radius: 20 },
  { id: 'deep-convection-mcs', label: 'deep convection / MCS', latitude: 5, longitude: -25, radius: 20 },
  { id: 'upper-cirrus', label: 'upper cirrus', latitude: 45, longitude: -170, radius: 20 },
  { id: 'high-latitude-mixed-phase', label: 'high-latitude mixed phase', latitude: -55, longitude: 100, radius: 20 },
];
const WARP_MODES = [
  {
    id: 'normal',
    label: 'normal',
    hours: [0, 1 / 60],
    simulationHoursPerFrame: '<= 1/60 h',
    expectation: 'cell, mesoscale, and weather-object continuity',
  },
  {
    id: 'intermediate',
    label: 'intermediate',
    hours: [6, 7],
    simulationHoursPerFrame: '6 h',
    expectation: 'mesoscale and synoptic structure is the primary continuity target',
  },
  {
    id: 'extreme',
    label: 'extreme',
    hours: [24, 30],
    simulationHoursPerFrame: '24 h',
    expectation: 'time-averaged / low-pass field without flash or abrupt disappearance',
  },
  {
    id: 'max-warp',
    label: 'max warp',
    hours: [155.28, 310.56],
    simulationHoursPerFrame: '6.47 d',
    expectation: 'natural satellite timelapse; no individual-object continuity requirement',
  },
];

function imageBytes(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

function resizeRgba(image, width, height) {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
      const sourceOffset = (sourceY * image.width + sourceX) * image.channels;
      const targetOffset = (y * width + x) * 4;
      output[targetOffset] = image.data[sourceOffset] ?? 0;
      output[targetOffset + 1] = image.data[sourceOffset + 1] ?? output[targetOffset];
      output[targetOffset + 2] = image.data[sourceOffset + 2] ?? output[targetOffset];
      output[targetOffset + 3] = image.channels === 4 ? image.data[sourceOffset + 3] ?? 255 : 255;
    }
  }
  return { width, height, data: output };
}

function contactSheet(images, columns, cellWidth, cellHeight) {
  const rows = Math.ceil(images.length / columns);
  const data = new Uint8Array(columns * cellWidth * rows * cellHeight * 4);
  data.fill(24);
  for (const [index, image] of images.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const resized = resizeRgba(image, cellWidth, cellHeight);
    for (let y = 0; y < cellHeight; y += 1) {
      const targetRow = row * cellHeight + y;
      const targetStart = (targetRow * columns * cellWidth + column * cellWidth) * 4;
      data.set(resized.data.subarray(y * cellWidth * 4, (y + 1) * cellWidth * 4), targetStart);
    }
  }
  return { width: columns * cellWidth, height: rows * cellHeight, data };
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-visual-review-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      '(document.getElementById("error")?.textContent || typeof window.cloudLab === "object")',
      'the cloud lab to initialise',
    );
    const failure = await devTools.evaluate('document.getElementById("error")?.textContent ?? ""');
    if (failure) throw new Error(`Cloud lab failed to initialise: ${failure}`);

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const assets = [];
    const sheets = [];
    const allRegimeOverviewImages = [];
    for (const regime of REGIMES) {
      await devTools.evaluate(
        `window.cloudLab.aimCap(${regime.latitude}, ${regime.longitude}, ${regime.radius})`,
      );
      let normalOverviewImage = null;
      const modeImages = [];
      for (const mode of WARP_MODES) {
        const imagePaths = [];
        for (const [sample, hours] of mode.hours.entries()) {
          await devTools.evaluate(`window.cloudLab.setTime(${hours})`);
          await devTools.evaluate(`window.cloudLab.show(${JSON.stringify(VIEW)})`);
          const bytes = imageBytes(await devTools.evaluate('window.cloudLab.capture()'));
          const filename = `${regime.id}-${mode.id}-${sample}.png`;
          const file = path.join(outDir, filename);
          writeFileSync(file, bytes);
          imagePaths.push(path.relative(root, file));
          assets.push({ regime: regime.id, mode: mode.id, sample, hours, file: path.relative(root, file) });
          modeImages.push(decodePng(bytes));
        }
        if (mode.id === 'normal') normalOverviewImage = modeImages[0];
        const sheet = contactSheet(modeImages, 2, SOURCE_WIDTH / 2, SOURCE_HEIGHT / 2);
        const filename = `${regime.id}-${mode.id}-contact.png`;
        const file = path.join(outDir, filename);
        writeFileSync(file, encodeRgbaPng(sheet.width, sheet.height, sheet.data));
        sheets.push({ regime: regime.id, mode: mode.id, file: path.relative(root, file), source: imagePaths });
      }
      if (normalOverviewImage !== null) allRegimeOverviewImages.push(normalOverviewImage);
      console.log(`reviewed ${regime.id}`);
    }

    const overview = contactSheet(allRegimeOverviewImages, 2, 768, 256);
    const overviewFile = path.join(outDir, 'all-regimes-overview.png');
    writeFileSync(overviewFile, encodeRgbaPng(overview.width, overview.height, overview.data));
    sheets.push({ regime: 'all', mode: 'overview', file: path.relative(root, overviewFile), source: REGIMES.map((regime) => regime.id) });

    const manifest = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      view: VIEW,
      sourceSize: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
      regimes: REGIMES,
      warpModes: WARP_MODES,
      assets,
      contactSheets: sheets,
      humanReview: {
        status: 'pending',
        checklist: [
          'normal: cell, mesoscale, and weather-object motion is continuous',
          'intermediate: mesoscale/synoptic structure remains legible without requiring cell identity',
          'extreme: field is low-pass/time-averaged with no flash, abrupt disappearance, or periodic blink',
          'max warp: sequence reads as a natural averaged satellite timelapse and does not alias the day cycle',
          'all regimes: parameterization blends continuously at fronts and around MCS/cirrus coexistence',
        ],
      },
      browserEvents: fatalEvents,
    };
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${assets.length} images and ${sheets.length} contact sheets to ${path.relative(root, outDir)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
