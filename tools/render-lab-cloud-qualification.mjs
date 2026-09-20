// 固定代表環境で no-cloud B0 と cloud-enabled の追加 GPU p95 を比較する。
// GPU timestamp-query が使えない環境では CPU 時間を代用せず、unqualified として保存する。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectFatalEvents, openChromeSession, waitFor } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, '.render-lab');
const outputPath = process.env.CLOUD_QUALIFICATION_OUT
  ?? path.join(root, '.cloud-lab', 'qualification.json');
const port = 8770;
const debugPort = 9447;
const FRAME_BUDGET_MS = 1000 / 60;
const SAMPLE_FRAMES = 30;
const WARMUP_FRAMES = 6;
const CAMERA_CASE = 'earth';
const CAMERA_ALTITUDES_KM = [70, 100, 400];
const DEFAULT_CASE_ALTITUDE_KM = 420;

function browserPath() {
  return process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

function browserVersion() {
  try {
    return execFileSync(browserPath(), ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

function budgetFor(noCloudP95Ms, cloudP95Ms, timestamp) {
  if (!Number.isFinite(noCloudP95Ms)) {
    return {
      noCloudP95Ms: null, cloudP95Ms: null, headroomMs: null, cloudBudgetMs: null,
      qualification: 'unqualified',
    };
  }
  const baseline = Math.max(0, noCloudP95Ms);
  const headroom = Math.max(0, FRAME_BUDGET_MS - baseline);
  const cloudBudget = headroom === 0 ? 0 : Math.min(0.20 * FRAME_BUDGET_MS, 0.50 * headroom);
  const measuredCloud = Number.isFinite(cloudP95Ms) ? Math.max(0, cloudP95Ms) : null;
  return {
    noCloudP95Ms: baseline,
    cloudP95Ms: measuredCloud,
    headroomMs: headroom,
    cloudBudgetMs: cloudBudget,
    qualification: timestamp && headroom > 0 && measuredCloud !== null && measuredCloud <= cloudBudget
      ? 'qualified' : 'unqualified',
  };
}

function cameraAngles(altitudeKm) {
  return { cameraDistanceLog: Math.log10(altitudeKm / DEFAULT_CASE_ALTITUDE_KM) };
}

async function main() {
  const { fatalEvents, onEvent } = collectFatalEvents();
  const session = await openChromeSession({
    serveDir: buildDir, port, debugPort, profilePrefix: 'tepui-cloud-qualification-', onEvent,
  });
  try {
    const { devTools } = session;
    await devTools.send('Page.navigate', { url: `${session.baseUrl}/` });
    await waitFor(
      devTools,
      '(document.getElementById("error")?.textContent || typeof window.renderLab?.measure === "function")',
      'the render lab to initialise',
    );
    const failure = await devTools.evaluate('document.getElementById("error")?.textContent ?? ""');
    if (failure) throw new Error(`Render lab failed to initialise: ${failure}`);

    const adapter = await devTools.evaluate(
      '(async () => { const a = await navigator.gpu?.requestAdapter(); const i = a?.info ?? {}; '
      + 'return { webgpu: Boolean(a), vendor: i.vendor ?? "", architecture: i.architecture ?? "", '
      + 'device: i.device ?? "", description: i.description ?? "" }; })()',
    );
    const rows = [];
    for (const altitudeKm of CAMERA_ALTITUDES_KM) {
      const angles = cameraAngles(altitudeKm);
      await devTools.evaluate('window.renderLab.setGraphicsOption("clouds", false)');
      const noCloud = await devTools.evaluate(
        `window.renderLab.measure(${JSON.stringify(CAMERA_CASE)}, ${JSON.stringify(angles)}, ${WARMUP_FRAMES}, ${SAMPLE_FRAMES})`,
      );
      await devTools.evaluate('window.renderLab.setGraphicsOption("clouds", true)');
      await devTools.evaluate('window.renderLab.setGraphicsOption("cloudFieldSource", "generated")');
      await devTools.evaluate('window.renderLab.setGraphicsOption("cumulusDetail", 2)');
      const cloud = await devTools.evaluate(
        `window.renderLab.measure(${JSON.stringify(CAMERA_CASE)}, ${JSON.stringify(angles)}, ${WARMUP_FRAMES}, ${SAMPLE_FRAMES})`,
      );
      const timestamp = Boolean(noCloud.gpuSupported && cloud.gpuSupported);
      const noCloudP95 = timestamp ? noCloud.gpuTotalMs.p95 : null;
      const cloudP95 = timestamp ? cloud.gpuTotalMs.p95 - noCloud.gpuTotalMs.p95 : null;
      const budget = budgetFor(noCloudP95, cloudP95, timestamp);
      rows.push({
        altitudeKm,
        caseName: CAMERA_CASE,
        angles,
        frames: SAMPLE_FRAMES,
        gpuTimestampSupported: timestamp,
        noCloudGpuTotalMs: noCloud.gpuTotalMs,
        cloudGpuTotalMs: cloud.gpuTotalMs,
        ...budget,
      });
      console.log(`${altitudeKm} km: ${budget.qualification} `
        + `(B0=${budget.noCloudP95Ms === null ? 'unavailable' : budget.noCloudP95Ms.toFixed(3)} ms, `
        + `cloud=${budget.cloudP95Ms === null ? 'unavailable' : budget.cloudP95Ms.toFixed(3)} ms)`);
    }

    const output = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      representativeDevice: { model: 'Apple M4 Pro', machine: 'Mac16,8', architecture: 'arm64' },
      browser: { name: 'Google Chrome', version: browserVersion(), ...adapter },
      frameBudgetMs: FRAME_BUDGET_MS,
      quality: { atmosphere: 'medium', clouds: true, cloudFieldSource: 'generated', cumulusDetail: 2 },
      cases: rows,
      qualification: rows.every((row) => row.qualification === 'qualified') ? 'qualified' : 'unqualified',
      rule: 'headroom=max(0,F-B0); Bcloud=min(0.20F,0.50headroom); headroom=0 is unqualified',
      review: fatalEvents.length === 0 ? 'no-fatal-browser-events' : { fatalEvents },
    };
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, outputPath)}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
