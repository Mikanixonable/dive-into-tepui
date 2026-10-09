// `npm run ci` の並列ランナー。直列の && 鎖だった検証を、docs/ への依存関係だけで
// 段階に分け、段内の独立した検査を同時に走らせる。段2(build)だけが docs/ と
// src/assets/tepui-rmqr.svg を書き、段3 はその出力を読む。失敗が出た段は全タスクの
// 完了を待ってから落ち、次の段は始めない。
import { runTask } from './run-tasks.mjs';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (label, command, args) => ({ label, command, args });

const STAGES = [
  [
    run('check-three-pin', 'node', ['tools/check-three-pin.mjs']),
    run('audit:prod', NPM, ['audit', '--omit=dev']),
    run('verify:source', NPM, ['run', 'verify:source']),
    run('verify:theme', NPM, ['run', 'verify:theme']),
    run('verify:ui-style', NPM, ['run', 'verify:ui-style']),
    run('verify:hud-layout', NPM, ['run', 'verify:hud-layout']),
    run('lint', NPM, ['run', 'lint']),
    run('check:boundaries', NPM, ['run', 'check:boundaries']),
    run('typecheck', NPM, ['run', 'typecheck']),
    run('protein:generate:check', 'node', ['tools/protein-builder/run-all.mjs', 'generate', '--check']),
    run('protein:generate-motion:check', 'node', ['tools/protein-builder/run-all.mjs', 'generate-motion', '--check']),
    run('protein:validate', 'node', ['tools/protein-builder/run-all.mjs', 'validate']),
    run('protein:validate-motion', 'node', ['tools/protein-builder/run-all.mjs', 'validate-motion']),
    run('protein:validate-structure', NPM, ['run', 'protein:validate-structure']),
    run('protein:catalog:check', NPM, ['run', 'protein:catalog:check']),
    run('test', NPM, ['run', 'test']),
    run('earth-surface:test:contract', 'node', ['tools/earth-surface/test_contract.mjs']),
    run('earth-surface:test:dev-delivery', NPM, ['run', 'earth-surface:test:dev-delivery']),
    run('earth-surface:test:release', NPM, ['run', 'earth-surface:test:release']),
  ],
  [run('build', NPM, ['run', 'build'])],
  [
    run('verify:release', NPM, ['run', 'verify:release']),
    run('smoke:browser', NPM, ['run', 'smoke:browser']),
  ],
];

const seconds = (ms) => (ms / 1000).toFixed(1);

// `--stage=N` でその段だけを走らせる(PR 用の軽い検査で段1だけを使うため)。
const stageArg = process.argv.find((arg) => arg.startsWith('--stage='));
const onlyStage = stageArg === undefined ? null : Number(stageArg.slice('--stage='.length));
if (onlyStage !== null && (!Number.isInteger(onlyStage) || onlyStage < 1 || onlyStage > STAGES.length)) {
  console.error(`--stage は 1〜${STAGES.length} の整数で指定すること: ${stageArg}`);
  process.exit(2);
}

let failed = false;
for (const [index, stage] of STAGES.entries()) {
  if (onlyStage !== null && index + 1 !== onlyStage) continue;
  const results = await Promise.all(stage.map(runTask));
  for (const result of results) {
    const status = result.code === 0 ? 'ok' : `FAIL(${result.error ? result.error.message : result.code})`;
    console.log(`${status} ${result.label} ${seconds(result.elapsed)}s`);
  }
  const failures = results.filter((result) => result.code !== 0);
  if (failures.length > 0) {
    console.error(`stage ${index + 1}: ${failures.length} 件失敗 — ${failures.map((f) => f.label).join(', ')}`);
    failed = true;
    break;
  }
}
process.exit(failed ? 1 : 0);
