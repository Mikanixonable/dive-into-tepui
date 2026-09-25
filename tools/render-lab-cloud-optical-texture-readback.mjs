// M4 Pro render-lab の DataArrayTexture 実upload後に、Three WebGPU backend のtexture→buffer copyを測る。
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputDirectory = path.resolve(root, process.argv[2] ?? '.render-lab/cloud-optical-texture-readback');
const port = 8793;
const debugPort = 9473;
const cases = ['cloud-event-optical-volume', 'cloud-event-optical-volume-rg16f'];

async function main() {
  execFileSync('node', [
    'node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production',
  ], { cwd: root, stdio: 'inherit' });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-texture-readback-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.readGpuTextureDiagnostic === 'function')",
      'the render lab GPU texture readback API to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    const adapter = await devTools.evaluate(`(async () => {
      const gpuAdapter = await navigator.gpu?.requestAdapter();
      if (!gpuAdapter) return null;
      const info = gpuAdapter.info;
      return {
        vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
        isFallbackAdapter: gpuAdapter.isFallbackAdapter ?? null,
        features: [...gpuAdapter.features].sort(),
      };
    })()`);
    const measurements = {};
    for (const name of cases) {
      measurements[name] = await devTools.evaluate(
        `window.renderLab.readGpuTextureDiagnostic(${JSON.stringify(name)})`,
      );
    }
    if (fatalEvents.length > 0) throw new Error(`Page reported browser/GPU errors:\n${fatalEvents.join('\n')}`);
    mkdirSync(outputDirectory, { recursive: true });
    const cpuBrand = process.platform === 'darwin'
      ? execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim()
      : null;
    const adapterIsAppleMetal = Boolean(adapter && /apple/i.test(`${adapter.vendor} ${adapter.description}`)
      && /metal/i.test(`${adapter.architecture} ${adapter.description}`) && adapter.isFallbackAdapter !== true);
    const m4ProHostConfirmed = /apple m4 pro/i.test(cpuBrand ?? '') && adapterIsAppleMetal;
    const report = {
      target: m4ProHostConfirmed
        ? 'Apple M4 Pro host confirmed by sysctl; Apple Metal WebGPU adapter'
        : 'Apple Metal adapter measured; M4 Pro host model is not confirmed by this run',
      host: { platform: process.platform, architecture: process.arch, cpuBrand, node: process.version },
      browser: await devTools.evaluate('navigator.userAgent'),
      threeVersion: '0.185.1',
      adapter,
      adapterIdentifiesAppleMetal: adapterIsAppleMetal,
      m4ProHostConfirmed,
      scope: 'raw GPU DataArrayTexture contents compared to CPU upload bits after render/upload',
      exclusions: [
        'does not test linear filtering or shader sampling',
        'does not test optical path integration or displayed color accuracy',
        'does not measure product GPU allocation, driver staging, or peak memory',
      ],
      measurements,
    };
    const reportPath = path.join(outputDirectory, 'cloud-optical-texture-readback.json');
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, adapter, formats: Object.keys(measurements) }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
