// tests/perf/ の実験をまとめて走らせるエントリポイント。
// 使い方: npx tsc -p tests/perf/tsconfig.perf.json && node tests/dist-perf/tests/perf/index.js
// 個別に走らせる場合は node tests/dist-perf/tests/perf/exp<N>-*.js を直接実行してもよい。
import { run as runExp4 } from './exp4-predictor-lookahead';
import { run as runExp11 } from './exp11-celestial-pivot';

runExp4();
runExp11();
