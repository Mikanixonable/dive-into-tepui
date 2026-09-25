// Read the C9 GPU ray-integral result from its fixed render-lab PNG tiles and report PNG quantization bounds.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputDirectory = path.resolve(root, process.argv[2] ?? '.render-lab-shots/cloud-optical-ray-c9');
const port = 8794;
const debugPort = 9474;
const caseName = 'cloud-optical-ray-c9';
const shotName = 'cloud-optical-ray-c9-gpu';
const width = 960;
const height = 540;
const rayNames = ['vertical', '45deg'];
const outputNames = ['liquidTau', 'iceTau', 'totalTau', 'transmittance'];
const calibrationValues = [0.1, 0.3, 0.5, 0.7, 0.9];
const requestedTolerance = 0.005;
const footprintRadiusM = 10_000;
const gridCellSizeM = 250;

function grayByteAt(image, x, y) {
  const offset = (y * image.width + x) * image.channels;
  if (image.channels === 4 && image.data[offset + 3] !== 255) {
    throw new Error(`transparent diagnostic pixel at (${x}, ${y})`);
  }
  if (image.data[offset] !== image.data[offset + 1] || image.data[offset] !== image.data[offset + 2]) {
    throw new Error(`non-gray diagnostic pixel at (${x}, ${y})`);
  }
  return image.data[offset];
}

function calibrationSamples(image) {
  return calibrationValues.map((expected, index) => ({
    expected,
    byte: grayByteAt(image, 22, 18 + index * 16),
  }));
}

function calibratedValue(byte, calibration) {
  for (let index = 0; index < calibration.length - 1; index += 1) {
    const lower = calibration[index];
    const upper = calibration[index + 1];
    if (byte >= lower.byte && byte <= upper.byte) {
      const byteSpan = upper.byte - lower.byte;
      const outputSpan = upper.expected - lower.expected;
      const fraction = (byte - lower.byte) / byteSpan;
      return {
        value: lower.expected + fraction * outputSpan,
        quantizationBound: outputSpan / byteSpan / 2,
      };
    }
  }
  return null;
}

function pixelAt(image, rayIndex, outputIndex) {
  const x = Math.floor((rayIndex + 0.5) * width / rayNames.length);
  const y = Math.floor((outputIndex + 0.5) * height / outputNames.length);
  return { x, y, byte: grayByteAt(image, x, y) };
}

function verifyCalibration(calibration, expectedValues) {
  for (let index = 0; index < calibration.length; index += 1) {
    if (index > 0 && calibration[index].byte <= calibration[index - 1].byte) {
      return 'calibration patches are not strictly increasing in encoded output';
    }
  }
  const minimumByte = calibration[0].byte;
  const maximumByte = calibration.at(-1).byte;
  for (const expected of expectedValues) {
    if (expected < calibration[0].expected || expected > calibration.at(-1).expected) {
      return `calibration reference values do not bracket expected shader result ${expected}`;
    }
  }
  if (minimumByte >= maximumByte) return 'calibration output range is empty';
  return null;
}

function expectedFor(rayName) {
  const pathFactor = rayName === '45deg' ? Math.SQRT2 : 1;
  const liquidTau = 2e-4 * 2_000 * pathFactor;
  const iceTau = 1e-4 * 2_000 * pathFactor;
  const totalTau = liquidTau + iceTau;
  return [liquidTau, iceTau, totalTau, Math.exp(-totalTau)];
}

async function main() {
  execFileSync('node', [
    'node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production',
  ], { cwd: root, stdio: 'inherit' });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-ray-probe-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      `(document.getElementById('error')?.textContent || window.renderLab?.cases?.includes(${JSON.stringify(caseName)}))`,
      'the C9 cloud optical ray case to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    const adapter = await devTools.evaluate(`(async () => {
      const gpuAdapter = await navigator.gpu?.requestAdapter();
      if (!gpuAdapter) return null;
      return {
        vendor: gpuAdapter.info.vendor, architecture: gpuAdapter.info.architecture,
        device: gpuAdapter.info.device, description: gpuAdapter.info.description,
        isFallbackAdapter: gpuAdapter.isFallbackAdapter ?? null,
      };
    })()`);
    const dataUrl = await devTools.evaluate(
      `window.renderLab.shoot(${JSON.stringify(caseName)}).then((pngs) => pngs[${JSON.stringify(shotName)}])`,
    );
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`render-lab did not return PNG shot ${shotName}`);
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported browser/GPU errors:\n${fatalEvents.join('\n')}`);

    const image = decodePng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    if (image.width !== width || image.height !== height || ![3, 4].includes(image.channels)) {
      throw new Error(`unexpected PNG dimensions/channels: ${image.width}x${image.height}/${image.channels}`);
    }
    const calibration = calibrationSamples(image);
    const analyticValues = rayNames.flatMap(expectedFor);
    const calibrationBlockReason = verifyCalibration(calibration, analyticValues.flat());
    if (calibrationBlockReason !== null) {
      const blockedReport = {
        status: 'blocked',
        blockedReason: calibrationBlockReason,
        calibration,
        method: 'known shader-linear grayscale patches measured through the same render pipeline and PNG output',
        rawFloatGpuReadback: false,
      };
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(path.join(outputDirectory, `${shotName}.png`),
        Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
      writeFileSync(path.join(outputDirectory, `${shotName}.json`), `${JSON.stringify(blockedReport, null, 2)}\n`);
      throw new Error(`BLOCKED: render-path calibration failed: ${calibrationBlockReason}`);
    }
    const rays = rayNames.map((rayName, rayIndex) => {
      const expected = expectedFor(rayName);
      const outputs = outputNames.map((name, outputIndex) => {
        const sample = pixelAt(image, rayIndex, outputIndex);
        const estimate = calibratedValue(sample.byte, calibration);
        if (estimate === null) {
          throw new Error(`BLOCKED: output sample ${rayName}/${name} lies outside calibration byte range`);
        }
        const error = Math.abs(estimate.value - expected[outputIndex]);
        const quantizationBound = estimate.quantizationBound;
        return {
          name,
          pixel: { x: sample.x, y: sample.y, srgb8: sample.byte },
          gpuPngCalibratedShaderValueEstimate: estimate.value,
          analyticExpected: expected[outputIndex],
          absoluteError: error,
          pngQuantizationHalfStepBound: quantizationBound,
          errorIntervalGivenPngQuantization: [Math.max(0, error - quantizationBound), error + quantizationBound],
          definitelyWithinTolerance: error + quantizationBound <= requestedTolerance,
        };
      });
      return { ray: rayName, outputs };
    });
    const host = {
      platform: process.platform,
      architecture: process.arch,
      cpuBrand: process.platform === 'darwin'
        ? execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim() : null,
    };
    const report = {
      status: 'measured-png-estimate',
      target: /apple m4 pro/i.test(host.cpuBrand ?? '') ? 'Apple M4 Pro host' : 'host model not confirmed',
      host,
      browser: await devTools.evaluate('navigator.userAgent'),
      threeVersion: '0.185.1',
      adapter,
      method: 'GPU shader results rendered into grayscale regions and sampled from 8-bit sRGB PNG',
      fixture: {
        shape: 'two concentric homogeneous circular disks in the local tangent plane',
        radiusM: footprintRadiusM,
        gridCellSizeM,
        layerEdgesM: [0, 1_000, 3_000, 6_000, 8_000],
        liquidExtinctionPerM: { betweenAltitudeM: [1_000, 3_000], value: 2e-4 },
        iceExtinctionPerM: { betweenAltitudeM: [6_000, 8_000], value: 1e-4 },
        allOtherLayers: 'zero extinction',
        testedRays: 'vertical and 45 degree, through the disk centers, altitude 0 to 8 km',
        exclusions: ['disk edge shape accuracy', 'parallax and shadow displacement', 'arbitrary spatial fields'],
      },
      calibration: {
        knownShaderLinearValues: calibrationValues,
        sampledGrayBytes: calibration,
        interpolation: 'piecewise linear inverse mapping in encoded byte space',
        note: 'Interpolated mapping calibration is an estimate; this does not replace float GPU output readback.',
      },
      limitations: [
        'PNG color quantization and render output conversion prevent raw floating-point shader-output verification.',
        'Texture contents and interpolation are part of the GPU shader path; no direct buffer readback of tau was made.',
        'This fixed homogeneous C9 fixture does not establish arbitrary spatially varying ray integration accuracy.',
      ],
      tolerance: { requestedAbsolute: requestedTolerance, passClaimedByPng: false },
      rays,
    };
    mkdirSync(outputDirectory, { recursive: true });
    const pngPath = path.join(outputDirectory, `${shotName}.png`);
    const reportPath = path.join(outputDirectory, `${shotName}.json`);
    writeFileSync(pngPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(report.tolerance.passClaimedByPng, false, 'PNG probes never claim the numeric gate passed');
    console.log(JSON.stringify({ reportPath, pngPath, adapter, rays }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
