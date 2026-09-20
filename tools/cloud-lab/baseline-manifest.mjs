// 雲baselineの再現条件を記録する。実際のフレーム計測値は render-lab の計測出力へ結び、
// このmanifestは代表機器/browserの固定と、未計測を合格扱いにしない境界を担当する。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const browserPath = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browserVersion = 'unavailable';
try {
  browserVersion = execFileSync(browserPath, ['--version'], { encoding: 'utf8' }).trim();
} catch {
  // CIや別OSではbrowser versionを取れなくても、manifestをunqualifiedで出力する。
}

const manifest = {
  schema: 2,
  representativeDevice: {
    model: 'Apple M4 Pro',
    machine: 'Mac16,8',
    architecture: 'arm64',
  },
  browser: {
    name: 'Google Chrome',
    version: browserVersion,
    webgpu: true,
  },
  frameBudgetMs: 1000 / 60,
  cloudBudget: {
    status: process.env.BASELINE_NO_CLOUD_P95_MS === undefined ? 'unmeasured' : 'baseline-measured',
    noCloudP95Ms: process.env.BASELINE_NO_CLOUD_P95_MS === undefined
      ? null : Number(process.env.BASELINE_NO_CLOUD_P95_MS),
    cloudP95Ms: process.env.BASELINE_CLOUD_P95_MS === undefined
      ? null : Number(process.env.BASELINE_CLOUD_P95_MS),
    gpuTimestampSupported: process.env.BASELINE_GPU_TIMESTAMP_SUPPORTED === 'true',
    qualification: 'unqualified',
    rule: 'headroom=max(0,F-B0); Bcloud=min(0.20F,0.50headroom); headroom=0 is unqualified',
  },
  capture: {
    cameraDistancesKm: [70, 100, 400],
    includeDistantView: true,
    regimes: [
      'trade-cumulus', 'marine-stratocumulus', 'temperate-front',
      'deep-convection-mcs', 'upper-cirrus', 'high-latitude-mixed-phase',
    ],
  },
};

const noCloudP95 = manifest.cloudBudget.noCloudP95Ms;
const frameBudget = manifest.frameBudgetMs;
if (Number.isFinite(noCloudP95)) {
  const headroom = Math.max(0, frameBudget - noCloudP95);
  manifest.cloudBudget.headroomMs = headroom;
  manifest.cloudBudget.cloudBudgetMs = headroom === 0
    ? 0 : Math.min(0.20 * frameBudget, 0.50 * headroom);
  const cloudP95 = manifest.cloudBudget.cloudP95Ms;
  if (manifest.cloudBudget.gpuTimestampSupported && headroom > 0 && Number.isFinite(cloudP95)
    && cloudP95 <= manifest.cloudBudget.cloudBudgetMs) {
    manifest.cloudBudget.qualification = 'qualified';
  }
}

const output = `${JSON.stringify(manifest, null, 2)}\n`;
const outputPath = process.env.BASELINE_MANIFEST_OUT;
if (outputPath) writeFileSync(outputPath, output);
process.stdout.write(output);
