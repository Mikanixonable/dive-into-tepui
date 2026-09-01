// tests/perf/ の実験をまとめて走らせるエントリポイント。
// 使い方: npx tsc -p tests/perf/tsconfig.perf.json && node tests/perf/dist/tests/perf/index.js
// 個別に走らせる場合は node tests/perf/dist/tests/perf/exp<N>-*.js を直接実行してもよい。
import { run as runExp4 } from './exp4-predictor-lookahead';

runExp4();
