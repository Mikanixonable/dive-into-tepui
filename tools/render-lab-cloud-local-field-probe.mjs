// render-lab の cloud-event-local-field 診断を headless Chrome+GPU で実行し、実イベント場の
// 局所光学場に対する GPU/CPU 数値一致レポートを .render-lab/diag/ へ書き出す。
// --self-test は GPU なしで、CPU 参照モジュールの import とケース登録の構造だけを点検する。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputDirectory = path.join(root, '.render-lab', 'diag');
const caseName = 'cloud-event-local-field';
const port = 8795;
const debugPort = 9475;
const nodeRequire = createRequire(import.meta.url);

function selfTest() {
  execFileSync('npm', ['run', 'test:compile'], { cwd: root, stdio: 'inherit' });
  const localField = nodeRequire(
    path.join(root, 'tests/dist/src/render/cloud/cloud-local-field.js'));
  const { v3 } = nodeRequire(path.join(root, 'tests/dist/src/math/vec3.js'));
  for (const name of [
    'CloudLocalFieldSampler', 'validateCloudLocalFieldFrame', 'cloudLocalUvAt',
    'cloudLocalDirectionAt', 'cloudLocalLayerIndexAt', 'sampleCloudLocalFieldCpu',
    'integrateCloudLocalFieldRayCpu',
  ]) {
    assert.equal(typeof localField[name], 'function', `missing CPU reference export: ${name}`);
  }
  // 診断ケースがテスト用コンパイルのグラフへ入っている(ケース登録で import されることの確認)。
  const caseModulePath = path.join(
    root, 'tests/dist/tools/render-lab/cloud-event-local-field-case.js');
  assert.ok(existsSync(caseModulePath), 'cloud-event-local-field case did not compile');
  const compiledCase = readFileSync(caseModulePath, 'utf8');
  for (const key of [
    'pointProbes', 'rayProbes', 'maxPositionErrorM', 'maxExtinctionErrorPerM',
    'maxTauError', 'estimatedGpuBaseLevelBytes', 'status',
  ]) {
    assert.ok(compiledCase.includes(key), `case module is missing report key: ${key}`);
  }
  const casesSource = readFileSync(path.join(root, 'tools/render-lab/cases.ts'), 'utf8');
  assert.ok(casesSource.includes(`'${caseName}'`), `${caseName} is not registered in cases.ts`);
  // CPU 参照の最小健全性: frame 検証・log-map 往復・空場の積分が透明であること。
  const frame = {
    centerDirection: v3(1, 0, 0), eastDirection: v3(0, 1, 0), northDirection: v3(0, 0, 1),
    sphereRadiusM: 6_371_000, gridOriginEastM: -8_000, gridOriginNorthM: -8_000,
    cellWidthM: 250, cellHeightM: 250, gridWidth: 64, gridHeight: 64,
    maxAngularDistanceRad: 0.02, layerEdgesM: [0, 3_000, 9_000],
  };
  assert.doesNotThrow(() => localField.validateCloudLocalFieldFrame(frame));
  const roundTrip = localField.cloudLocalUvAt(
    localField.cloudLocalDirectionAt(1_000, -2_000, frame), frame);
  assert.ok(Math.abs(roundTrip.eastM - 1_000) < 1e-6);
  assert.ok(Math.abs(roundTrip.northM + 2_000) < 1e-6);
  const emptyVolume = {
    width: 64, height: 64, layerEdgesM: new Float32Array([0, 3_000, 9_000]),
    liquidExtinctionPerM: new Float32Array(64 * 64 * 2),
    iceExtinctionPerM: new Float32Array(64 * 64 * 2),
  };
  const emptyPath = localField.integrateCloudLocalFieldRayCpu(
    localField.cloudLocalDirectionAt(0, 0, frame),
    localField.cloudLocalDirectionAt(0, 0, frame), emptyVolume, frame, 8);
  assert.equal(emptyPath.totalTau, 0);
  assert.equal(emptyPath.transmittance, 1);
  console.log('cloud local field probe self-test passed');
}

async function main() {
  if (process.argv[2] === '--self-test') {
    selfTest();
    return;
  }
  execFileSync('node', [
    'node_modules/webpack-cli/bin/cli.js', '--config', 'webpack.render-lab.config.js', '--mode', 'production',
  ], { cwd: root, stdio: 'inherit' });
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-local-field-probe-',
    windowSize: { width: 640, height: 640 }, onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      "(document.getElementById('error')?.textContent || typeof window.renderLab?.readGpuTextureDiagnostic === 'function')",
      'the render lab GPU texture diagnostic API to initialise',
    );
    const failure = await devTools.evaluate("document.getElementById('error')?.textContent ?? ''");
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);
    const adapter = await devTools.evaluate(`(async () => {
      const gpuAdapter = await navigator.gpu?.requestAdapter();
      if (!gpuAdapter) return null;
      const info = gpuAdapter.info;
      return {
        vendor: info.vendor, architecture: info.architecture, device: info.device,
        description: info.description, isFallbackAdapter: gpuAdapter.isFallbackAdapter ?? null,
      };
    })()`);
    const report = await devTools.evaluate(
      `window.renderLab.readGpuTextureDiagnostic(${JSON.stringify(caseName)})`);
    if (fatalEvents.length > 0) throw new Error(`Page reported browser/GPU errors:\n${fatalEvents.join('\n')}`);
    if (report === null || typeof report !== 'object') {
      throw new Error(`diagnostic did not return a report object: ${String(report)}`);
    }
    const adapterSlug = adapter === null ? 'no-adapter'
      : ([adapter.vendor, adapter.architecture].filter(Boolean).join('-')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-adapter');
    mkdirSync(outputDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(outputDirectory, `${caseName}-${adapterSlug}-${timestamp}.json`);
    writeFileSync(reportPath, `${JSON.stringify({
      caseName,
      browser: await devTools.evaluate('navigator.userAgent'),
      adapter,
      ...report,
    }, null, 2)}\n`);
    console.log(JSON.stringify({
      reportPath, adapter, status: report.status,
      maxErrors: report.maxErrors, gates: report.gates,
    }, null, 2));
    if (report.status !== 'pass') {
      process.exitCode = 1;
      console.error(`GATE FAILED: ${caseName} GPU/CPU parity did not meet the fixed tolerances`);
    }
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
