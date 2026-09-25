// Capture the fixed render-lab GPU probe shot and compare PNG samples with the CPU bilinear oracle.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const caseName = 'cloud-optical-volume';
const shotName = 'cloud-optical-volume-gpu-oracle';
const probeSetName = 'cloud-optical-volume-gpu-oracle';
const outputDirectory = path.join(root, '.render-lab-shots', probeSetName);
const width = 960;
const height = 540;
const columns = 4;
const rows = 3;
const displayScale = 100;
const referenceLinear = 0.4;
const maxAbsoluteErrorPerM = 5e-5;
const layerEdgesM = [0, 1_000, 3_000, 7_000, 12_000];
const probeAltitudesM = [0, 0.1, 999.9, 1_000, 2_999.9, 3_000, 6_999.9, 7_000, 12_000];
const probeUVs = [[1.5 / 32, 16.5 / 32], [4 / 32, 16.25 / 32], [0, 0.5]];
const neutralToneMapLinearMaximum = 0.76;
const nodeRequire = createRequire(import.meta.url);
let sampleCloudOpticalVolumeCpu;

function extinctionData() {
  const liquid = new Float32Array(32 * 32 * 4);
  const ice = new Float32Array(liquid.length);
  for (let layer = 0; layer < 4; layer += 1) {
    for (let y = 0; y < 32; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        const index = layer * 32 * 32 + y * 32 + x;
        const east = (x + 0.5) / 32;
        const north = (y + 0.5) / 32;
        liquid[index] = layer < 2 && Math.sin(east * Math.PI * 8) > 0
          ? (0.001 + 0.001 * north) * (layer + 1) : 0.0005 * (layer + 1);
        ice[index] = layer >= 2 && Math.sin((east + north) * Math.PI * 5) > 0.25
          ? 0.0015 * (layer - 1) : 0.0005 * (layer + 1);
      }
    }
  }
  return {
    width: 32,
    height: 32,
    layerEdgesM: new Float32Array(layerEdgesM),
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  };
}

function loadProductionCpuSampler() {
  execFileSync('npm', ['run', 'test:compile'], { cwd: root, stdio: 'inherit' });
  ({ sampleCloudOpticalVolumeCpu } = nodeRequire(
    path.join(root, 'tests/dist/src/render/cloud/cloud-optical-volume.js'),
  ));
}

function linearOfSrgb8(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearCodeStep(byte) {
  const below = linearOfSrgb8(Math.max(0, byte - 1));
  const above = linearOfSrgb8(Math.min(255, byte + 1));
  return Math.max(linearOfSrgb8(byte) - below, above - linearOfSrgb8(byte));
}

function layerOfAltitude(altitudeM) {
  if (altitudeM < layerEdgesM[0] || altitudeM > layerEdgesM.at(-1)) {
    throw new RangeError(`probe altitude ${altitudeM} m is outside the volume`);
  }
  if (altitudeM === layerEdgesM.at(-1)) return layerEdgesM.length - 2;
  for (let layer = 0; layer < layerEdgesM.length - 1; layer += 1) {
    if (altitudeM < layerEdgesM[layer + 1]) return layer;
  }
  throw new RangeError(`no layer for altitude ${altitudeM} m`);
}

// Same normalized-UV texel-center convention as DataArrayTexture LinearFilter + ClampToEdge.
function sampleCpu(values, layer, u, v, widthValue = 32, heightValue = 32) {
  const x = Math.min(Math.max(u, 0), 1) * widthValue - 0.5;
  const y = Math.min(Math.max(v, 0), 1) * heightValue - 0.5;
  const xRaw = Math.floor(x);
  const yRaw = Math.floor(y);
  const tx = x - xRaw;
  const ty = y - yRaw;
  const x0 = Math.min(Math.max(xRaw, 0), widthValue - 1);
  const x1 = Math.min(Math.max(xRaw + 1, 0), widthValue - 1);
  const y0 = Math.min(Math.max(yRaw, 0), heightValue - 1);
  const y1 = Math.min(Math.max(yRaw + 1, 0), heightValue - 1);
  const offset = layer * widthValue * heightValue;
  const a = values[offset + y0 * widthValue + x0];
  const b = values[offset + y0 * widthValue + x1];
  const c = values[offset + y1 * widthValue + x0];
  const d = values[offset + y1 * widthValue + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function pixelCenter(column, row) {
  return {
    x: Math.floor((column + 0.5) * width / columns),
    y: Math.floor((row + 0.5) * height / rows),
  };
}

function pixelAt(image, column, row) {
  const { x, y } = pixelCenter(column, row);
  const offset = (y * image.width + x) * image.channels;
  return [linearOfSrgb8(image.data[offset]), linearOfSrgb8(image.data[offset + 1]),
    linearOfSrgb8(image.data[offset + 2])];
}

function buildResults(image) {
  if (image.width !== width || image.height !== height || ![3, 4].includes(image.channels)) {
    throw new Error(`unexpected shot dimensions/channels: ${image.width}x${image.height}/${image.channels}`);
  }
  const reference = pixelAt(image, 3, 2);
  if (reference[0] <= 0 || reference[2] <= 0) throw new Error('reference patch is not visible in both channels');
  // neutralToneMapping is identity below linear 0.76 when the minimum RGB channel is zero.
  if (reference[0] >= neutralToneMapLinearMaximum || reference[2] >= neutralToneMapLinearMaximum) {
    throw new Error('BLOCKED: reference patch is outside neutral-tone-mapping linear range');
  }
  const exposureEstimate = (reference[0] + reference[2]) / (2 * referenceLinear);
  const data = extinctionData();
  const results = probeAltitudesM.map((altitudeM, index) => {
    const layer = layerOfAltitude(altitudeM);
    const [u, v] = probeUVs[index % probeUVs.length];
    const observed = pixelAt(image, index % columns, Math.floor(index / columns));
    const cpuSample = sampleCloudOpticalVolumeCpu(data, u, v, altitudeM);
    const cpuLiquid = cpuSample.liquidExtinctionPerM;
    const cpuIce = cpuSample.iceExtinctionPerM;
    const measuredLiquid = observed[0] / reference[0] * referenceLinear / displayScale;
    const measuredIce = observed[2] / reference[2] * referenceLinear / displayScale;
    return {
      altitudeM, selectedLayer: layer, u, v,
      cpuLiquidExtinctionPerM: cpuLiquid,
      gpuPngLiquidExtinctionPerM: measuredLiquid,
      liquidAbsoluteErrorPerM: Math.abs(measuredLiquid - cpuLiquid),
      cpuIceExtinctionPerM: cpuIce,
      gpuPngIceExtinctionPerM: measuredIce,
      iceAbsoluteErrorPerM: Math.abs(measuredIce - cpuIce),
    };
  });
  const referencePixel = pixelCenter(3, 2);
  const referenceOffset = (referencePixel.y * image.width + referencePixel.x) * image.channels;
  const quantization = Math.max(...results.flatMap((_, index) => [0, 2].map((channel) => {
    const referenceChannelValue = reference[channel];
    const referenceByte = image.data[referenceOffset + channel];
    const samplePixel = pixelCenter(index % columns, Math.floor(index / columns));
    const sampleByte = image.data[(samplePixel.y * image.width + samplePixel.x) * image.channels + channel];
    const measured = pixelAt(image, index % columns, Math.floor(index / columns))[channel]
      / referenceChannelValue * referenceLinear / displayScale;
    return (linearCodeStep(sampleByte) / referenceChannelValue
      + measured * linearCodeStep(referenceByte) / referenceChannelValue) * referenceLinear / displayScale;
  })));
  return { reference, exposureEstimate, quantizationFloorPerM: quantization, results };
}

function assertResults(report) {
  if (report.quantizationFloorPerM >= maxAbsoluteErrorPerM) {
    throw new Error(`BLOCKED: PNG quantization floor ${report.quantizationFloorPerM} exceeds fixed tolerance`);
  }
  for (const result of report.results) {
    if (result.cpuLiquidExtinctionPerM <= 0 || result.cpuIceExtinctionPerM <= 0) {
      throw new Error(`probe did not cover both phase channels at ${result.altitudeM} m`);
    }
    if (result.liquidAbsoluteErrorPerM > maxAbsoluteErrorPerM || result.iceAbsoluteErrorPerM > maxAbsoluteErrorPerM) {
      throw new Error(`CPU/GPU PNG parity failed at ${result.altitudeM} m (layer ${result.selectedLayer})`);
    }
  }
  const activeLiquid = report.results.some((result) =>
    result.cpuLiquidExtinctionPerM > 0.0005 * (result.selectedLayer + 1) + 1e-6);
  const activeIce = report.results.some((result) =>
    result.cpuIceExtinctionPerM > 0.0005 * (result.selectedLayer + 1) + 1e-6);
  if (!activeLiquid || !activeIce) throw new Error('probe set missed active liquid or ice pattern texels');
  const stripeBoundary = report.results[1];
  const stripeBaseline = 0.0005 * (stripeBoundary.selectedLayer + 1);
  if (!(stripeBoundary.cpuLiquidExtinctionPerM > stripeBaseline + 1e-6
    && stripeBoundary.cpuLiquidExtinctionPerM < 0.002)) {
    throw new Error('probe set missed the expected liquid stripe bilinear blend');
  }
}

function selfTest() {
  if (typeof sampleCloudOpticalVolumeCpu !== 'function') {
    throw new Error('production CPU sampler was not loaded');
  }
  assert.equal(layerOfAltitude(0), 0);
  assert.equal(layerOfAltitude(1_000), 1);
  assert.equal(layerOfAltitude(12_000), 3);
  assert.throws(() => layerOfAltitude(-0.1), RangeError);
  assert.throws(() => layerOfAltitude(12_000.1), RangeError);
  const knownData = {
    width: 2,
    height: 2,
    layerEdgesM: new Float32Array([0, 1_000, 3_000]),
    liquidExtinctionPerM: new Float32Array([1, 2, 3, 4, 10, 20, 30, 40]),
    iceExtinctionPerM: new Float32Array([5, 6, 7, 8, 50, 60, 70, 80]),
  };
  assert.equal(sampleCpu(knownData.liquidExtinctionPerM, 0, 0.5, 0.5, 2, 2), 2.5);
  assert.deepEqual(sampleCloudOpticalVolumeCpu(knownData, 0.5, 0.5, 0), {
    liquidExtinctionPerM: 2.5, iceExtinctionPerM: 6.5,
  });
  assert.deepEqual(sampleCloudOpticalVolumeCpu(knownData, 0.5, 0.5, 1_000), {
    liquidExtinctionPerM: 25, iceExtinctionPerM: 65,
  });
  assert.deepEqual(sampleCloudOpticalVolumeCpu(knownData, 0, 0, 999.9), {
    liquidExtinctionPerM: 1, iceExtinctionPerM: 5,
  });
  assert.deepEqual(sampleCloudOpticalVolumeCpu(knownData, 0.625, 0.625, 0), {
    liquidExtinctionPerM: 3.25, iceExtinctionPerM: 7.25,
  });
  assert.equal(sampleCpu(knownData.liquidExtinctionPerM, 0, 0.625, 0.625, 2, 2), 3.25);
  assert.ok(Math.abs(linearOfSrgb8(188) - 0.502886458) < 1e-8);
  const fixtureData = extinctionData();
  const activeLiquid = sampleCloudOpticalVolumeCpu(fixtureData, probeUVs[0][0], probeUVs[0][1], 0);
  const stripeBlend = sampleCloudOpticalVolumeCpu(fixtureData, probeUVs[1][0], probeUVs[1][1], 0);
  const activeIce = sampleCloudOpticalVolumeCpu(fixtureData, probeUVs[0][0], probeUVs[0][1], 3_000);
  assert.ok(activeLiquid.liquidExtinctionPerM > 0.0005);
  assert.ok(activeIce.iceExtinctionPerM > 0.0015);
  assert.ok(stripeBlend.liquidExtinctionPerM > 0.0005 && stripeBlend.liquidExtinctionPerM < 0.002);
  console.log('cloud optical volume PNG probe self-test passed');
}

async function main() {
  loadProductionCpuSampler();
  if (process.argv[2] === '--self-test') {
    selfTest();
    return;
  }
  execFileSync('node', ['node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production'],
    { cwd: root, stdio: 'inherit' });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: path.join(root, '.render-lab'), port: 8791, debugPort: 9471,
    profilePrefix: 'tepui-cloud-optical-probe-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.shoot === 'function')",
      'render-lab initialisation');
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`render-lab failed to initialise: ${failure}`);
    const dataUrl = await devTools.evaluate(
      `window.renderLab.shoot(${JSON.stringify(caseName)}, { filmLut: 'none', antialias: 0 })`
      + `.then((pngs) => pngs[${JSON.stringify(shotName)}])`,
    );
    if (typeof dataUrl !== 'string') throw new Error(`missing fixed shot ${shotName}`);
    if (fatalEvents.length) throw new Error(`browser/GPU reported errors:\n${fatalEvents.join('\n')}`);
    const imageBytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    const image = decodePng(imageBytes);
    const report = buildResults(image);
    assertResults(report);
    mkdirSync(outputDirectory, { recursive: true });
    const pngPath = path.join(outputDirectory, `${shotName}.png`);
    const reportPath = path.join(outputDirectory, `${shotName}.json`);
    writeFileSync(pngPath, imageBytes);
    writeFileSync(reportPath, `${JSON.stringify({
      caseName, shotName, frame: 1, oracle: 'sampleCloudOpticalVolumeCpu at CPU-selected layer',
      maxAbsoluteErrorPerM, displayScale, referenceLinear, neutralToneMapLinearMaximum,
      colorPath: 'PNG decoded to linear sRGB; none LUT; no AA; reference-normalized neutral tone mapping',
      ...report,
    }, null, 2)}\n`);
    console.log(JSON.stringify({ pngPath, reportPath, exposureEstimate: report.exposureEstimate,
      quantizationFloorPerM: report.quantizationFloorPerM, sampleCount: report.results.length,
      maxObservedErrorPerM: Math.max(...report.results.flatMap((result) => [
        result.liquidAbsoluteErrorPerM, result.iceAbsoluteErrorPerM,
      ])) }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
