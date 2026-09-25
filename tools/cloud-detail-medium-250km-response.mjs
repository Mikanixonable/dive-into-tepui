// 250 km medium・832×468 内部ラスタで2 km残差タイルの4方向応答を測る。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const caseName = 'earth';
const shotName = 'cloud-detail-residual-250km-cloudy-diagnostic';
const directionsDeg = [0, 45, 90, 135];
const productMediumRaster = { width: 720, height: 405 };
const nativeRaster = { width: 864, height: 486 };
const referenceRaster = { width: 1728, height: 972 };
const nativeScale = nativeRaster.width / 960;
const referenceScale = referenceRaster.width / 960;
const minimumSamplesPerWavelength = 4;
const minimumRetainedAmplitude = 0.50;
const wavelengthKm = 2;

function linear(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminanceAt(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return 0.2126 * linear(image.data[offset])
    + 0.7152 * linear(image.data[offset + 1])
    + 0.0722 * linear(image.data[offset + 2]);
}

function downsample(image, width, height) {
  if (image.channels !== 4 || image.width % width !== 0 || image.height % height !== 0
    || image.width / width !== image.height / height) {
    throw new Error(`reference dimensions ${image.width}x${image.height} cannot area-downsample to ${width}x${height}`);
  }
  const factor = image.width / width;
  const values = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          sum += luminanceAt(image, x * factor + dx, y * factor + dy);
        }
      }
      values[y * width + x] = sum / (factor * factor);
    }
  }
  return values;
}

function nativeLuminance(image) {
  if (image.width !== nativeRaster.width || image.height !== nativeRaster.height || image.channels !== 4) {
    throw new Error(`native image dimensions are ${image.width}x${image.height}x${image.channels}`);
  }
  const values = new Float64Array(nativeRaster.width * nativeRaster.height);
  for (let y = 0; y < nativeRaster.height; y += 1) {
    for (let x = 0; x < nativeRaster.width; x += 1) values[y * nativeRaster.width + x] = luminanceAt(image, x, y);
  }
  return values;
}

function retainedAmplitude(native, invertedNative, reference, invertedReference) {
  let sumNative = 0;
  let sumReference = 0;
  let sumNativeSquared = 0;
  let sumReferenceSquared = 0;
  let sumProduct = 0;
  let count = 0;
  const { width, height } = nativeRaster;
  // 中央50%を使い、ケース端と地平線近傍による切り落としの影響を避ける。
  for (let y = Math.floor(height * 0.25); y < Math.ceil(height * 0.75); y += 1) {
    for (let x = Math.floor(width * 0.25); x < Math.ceil(width * 0.75); x += 1) {
      const index = y * width + x;
      const n = native[index] - invertedNative[index];
      const r = reference[index] - invertedReference[index];
      sumNative += n;
      sumReference += r;
      sumNativeSquared += n * n;
      sumReferenceSquared += r * r;
      sumProduct += n * r;
      count += 1;
    }
  }
  const covariance = sumProduct - sumNative * sumReference / count;
  const nativeVariance = sumNativeSquared - sumNative * sumNative / count;
  const referenceVariance = sumReferenceSquared - sumReference * sumReference / count;
  if (nativeVariance <= 0 || referenceVariance <= 0) throw new Error('wave response has zero variance');
  return {
    retainedAmplitude: covariance / referenceVariance,
    correlation: covariance / Math.sqrt(nativeVariance * referenceVariance),
    referenceRms: Math.sqrt(referenceVariance / count),
  };
}

execFileSync(process.execPath, ['node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production'], {
  cwd: root, stdio: 'inherit',
});

const { fatalEvents, onEvent } = collectFatalEvents();
const session = await openChromeSession({
  serveDir: path.join(root, '.render-lab'), port: 8792, debugPort: 9469,
  profilePrefix: 'tepui-cloud-detail-250km-response-', onEvent,
});
try {
  const { devTools } = session;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
  await waitFor(devTools,
    "(document.getElementById('error')?.textContent || typeof window.renderLab?.shootNative === 'function')",
    'render lab diagnostic capture API');
  const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
  if (failure) throw new Error(`render lab failed to initialise: ${failure}`);

  const images = new Map();
  for (const directionDeg of directionsDeg) {
    for (const phaseDeg of [0, 180]) {
      for (const [label, resolutionScale] of [['native', nativeScale], ['reference', referenceScale]]) {
        const pngDataUrl = await devTools.evaluate(`window.renderLab.shootNative(
          ${JSON.stringify(caseName)}, ${JSON.stringify(shotName)},
          ${JSON.stringify({ resolutionScale })},
          ${JSON.stringify({ wavelengthKm, directionDeg, phaseDeg, composition: 'coverage-residual' })})`);
        const png = Buffer.from(pngDataUrl.slice(pngDataUrl.indexOf(',') + 1), 'base64');
        const image = decodePng(png);
        const expected = label === 'native' ? nativeRaster : referenceRaster;
        if (image.width !== expected.width || image.height !== expected.height) {
          throw new Error(`${label} raster is ${image.width}x${image.height}; expected ${expected.width}x${expected.height}`);
        }
        const suffix = `${label}-${directionDeg}-${phaseDeg}`;
        images.set(suffix, label === 'native' ? nativeLuminance(image) : downsample(image, nativeRaster.width, nativeRaster.height));
        const output = path.join(root, '.render-lab', 'cloud-detail-250km-response', `${suffix}.png`);
        mkdirSync(path.dirname(output), { recursive: true });
        writeFileSync(output, png);
      }
    }
  }
  if (fatalEvents.length) throw new Error(`page reported errors:\n${fatalEvents.join('\n')}`);

  const estimatedSamples = (wavelengthKm * 1000 / 432) * (nativeRaster.width / 960);
  const rows = directionsDeg.map((directionDeg) => {
    const native = images.get(`native-${directionDeg}-0`);
    const invertedNative = images.get(`native-${directionDeg}-180`);
    const reference = images.get(`reference-${directionDeg}-0`);
    const invertedReference = images.get(`reference-${directionDeg}-180`);
    const response = retainedAmplitude(native, invertedNative, reference, invertedReference);
    return {
      wavelengthKm, directionDeg, ...response,
      diagnosticPass: estimatedSamples >= minimumSamplesPerWavelength
        && response.retainedAmplitude >= minimumRetainedAmplitude,
    };
  });
  const report = {
    purpose: 'diagnostic raster response only; this does not qualify physical cloud generation or GPU performance',
    caseName, shotName,
    targetGpu: 'Apple M4 Pro (host selection is external to this raster-response measurement)',
    productSettingsChanged: false,
    productMediumRaster: {
      ...productMediumRaster,
      estimatedSamplesPerWavelength: (wavelengthKm * 1000 / 432) * (productMediumRaster.width / 960),
      qualifiesFourSampleGate: false,
    },
    nativeRaster, referenceRaster, referenceDownsampleFactor: 2, nativeScale, referenceScale,
    sampleEstimate: {
      method: 'approximate; derived from the plan nominal 432 m/output-pixel at 960 CSS pixels, then scaled by raster width',
      nominalSurfaceMetresPerOutputPixelAt960CssPixels: 432,
      nativeRasterEstimatedSamplesPerWavelength: estimatedSamples,
      measuredProjection: false,
    },
    fixedGate: { minimumSamplesPerWavelength, minimumRetainedAmplitude },
    resultScope: 'diagnostic raster only; retained-amplitude values and diagnosticPass flags are not physical-generation or product-performance qualifications',
    allDirectionsDiagnosticPass: rows.every((row) => row.diagnosticPass),
    rows,
  };
  const output = path.join(root, '.render-lab', 'cloud-detail-250km-response.json');
  writeFileSync(output, JSON.stringify(report, null, 2));
  for (const row of rows) console.log(JSON.stringify(row));
  console.log(output);
} finally {
  await session.close();
}
