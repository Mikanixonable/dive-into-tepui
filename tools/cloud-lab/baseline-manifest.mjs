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
  schema: 1,
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
    status: 'unmeasured',
    qualification: 'unqualified',
    rule: 'headroom=max(0,F-B0); Bcloud=min(0.20F,0.50headroom); headroom=0 is unqualified',
  },
  capture: {
    cameraDistancesKm: [70, 100, 400],
    includeDistantView: true,
    temporalLod: ['normal', 'intermediate', 'extreme'],
  },
};

const output = `${JSON.stringify(manifest, null, 2)}\n`;
const outputPath = process.env.BASELINE_MANIFEST_OUT;
if (outputPath) writeFileSync(outputPath, output);
process.stdout.write(output);
