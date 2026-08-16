// tests/perf/ の4実験をまとめて走らせるエントリポイント。
// 使い方: npx tsc -p tests/perf/tsconfig.perf.json && node tests/perf/dist/tests/perf/index.js
// 個別に走らせる場合は node tests/perf/dist/tests/perf/exp<N>-*.js を直接実行してもよい
// (実験1は真値積分に、実験2は乖離探索に、それぞれ数十秒かかる)。
import { run as runExp1 } from './exp1-rk4-error';
import { run as runExp2 } from './exp2-divergence';
import { run as runExp3 } from './exp3-gravity-cost';
import { run as runExp4 } from './exp4-predictor-lookahead';

const sep = () => console.log('\n' + '='.repeat(80) + '\n');

runExp1();
sep();
runExp2();
sep();
runExp3();
sep();
runExp4();
