// 手順8-15の run の収束した4帯を、ケースごとに基準の尺度の符号付き PNG(×1・×4)と集計へ書く。
// 使い方: node tools/render-lab-screen-space-band-images.mjs [--runs=before-a,x,...]
// 省くと記録のあるすべての run。出力は runs/<run>/<ケース>/bands/ の新規ファイルだけ。
import { SCENES } from './screen-space-chain-setup.mjs';
import { metricsOf, runLabels } from './screen-space-chain-runs.mjs';
import { writeConvergedBands } from './screen-space-chain-bands.mjs';

const runsArgument = process.argv.find((arg) => arg.startsWith('--runs='));
const runs = runsArgument === undefined ? runLabels() : runsArgument.slice('--runs='.length).split(',');

for (const run of runs) {
  for (const { name } of SCENES) {
    if (metricsOf(run, name) === null) continue;
    const summary = writeConvergedBands(run, name);
    if (summary === null) console.warn(`${run}/${name}: converged band means are missing in the cache`);
    else console.log(`${run}/${name}: mean band ${summary.meanBandNumber?.toFixed(3)}`);
  }
}
