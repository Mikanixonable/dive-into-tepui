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
const pngQuantizationGate = 0.005;

function linearFromSrgbByte(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearHalfStep(byte) {
  const center = linearFromSrgbByte(byte);
  const lower = linearFromSrgbByte(Math.max(0, byte - 1));
  const upper = linearFromSrgbByte(Math.min(255, byte + 1));
  return Math.max(center - lower, upper - center) / 2;
}

function pixelAt(image, rayIndex, outputIndex) {
  const x = Math.floor((rayIndex + 0.5) * width / rayNames.length);
  const y = Math.floor((outputIndex + 0.5) * height / outputNames.length);
  const offset = (y * image.width + x) * image.channels;
  return { x, y, byte: image.data[offset], linear: linearFromSrgbByte(image.data[offset]) };
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
    const rays = rayNames.map((rayName, rayIndex) => {
      const expected = expectedFor(rayName);
      const outputs = outputNames.map((name, outputIndex) => {
        const sample = pixelAt(image, rayIndex, outputIndex);
        const error = Math.abs(sample.linear - expected[outputIndex]);
        const quantizationBound = linearHalfStep(sample.byte);
        return {
          name,
          pixel: { x: sample.x, y: sample.y, srgb8: sample.byte },
          gpuPngLinearEstimate: sample.linear,
          analyticExpected: expected[outputIndex],
          absoluteError: error,
          pngQuantizationHalfStepBound: quantizationBound,
          errorIntervalGivenPngQuantization: [Math.max(0, error - quantizationBound), error + quantizationBound],
          definitelyWithinAbsolute005: error + quantizationBound <= pngQuantizationGate,
          possiblyWithinAbsolute005: Math.max(0, error - quantizationBound) <= pngQuantizationGate,
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
      target: /apple m4 pro/i.test(host.cpuBrand ?? '') ? 'Apple M4 Pro host' : 'host model not confirmed',
      host,
      browser: await devTools.evaluate('navigator.userAgent'),
      threeVersion: '0.185.1',
      adapter,
      method: 'GPU shader results rendered into grayscale regions and sampled from 8-bit sRGB PNG',
      limitations: [
        'PNG color quantization and render output conversion prevent raw floating-point shader-output verification.',
        'Texture contents and interpolation are part of the GPU shader path; no direct buffer readback of tau was made.',
        'This fixed homogeneous C9 fixture does not establish arbitrary spatially varying ray integration accuracy.',
      ],
      tolerance: {
        requestedAbsolute: pngQuantizationGate,
        interpretation: 'A pass requires the entire reported error interval to fit inside this tolerance.',
        passClaimedByPng: false,
      },
      rays,
    };
    mkdirSync(outputDirectory, { recursive: true });
    const pngPath = path.join(outputDirectory, `${shotName}.png`);
    const reportPath = path.join(outputDirectory, `${shotName}.json`);
    writeFileSync(pngPath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    for (const ray of rays) {
      for (const output of ray.outputs) {
        assert.ok(output.possiblyWithinAbsolute005,
          `${ray.ray}/${output.name} is incompatible with tolerance even allowing PNG quantization`);
      }
    }
    console.log(JSON.stringify({ reportPath, pngPath, adapter, rays }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
