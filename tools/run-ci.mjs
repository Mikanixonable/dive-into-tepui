// `npm run ci` の並列ランナー。直列の && 鎖だった検証を、docs/ への依存関係だけで
// 段階に分け、段内の独立した検査を同時に走らせる。段2(build)だけが docs/ と
// src/assets/tepui-rmqr.svg を書き、段3 はその出力を読む。失敗が出た段は全タスクの
// 完了を待ってから落ち、次の段は始めない。
import { spawn } from 'node:child_process';

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

const runTask = ({ label, command, args }) =>
  new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (stream, writer) => {
      let rest = '';
      stream.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) writer(`[${label}] ${line}\n`);
      });
      stream.on('end', () => {
        if (rest) writer(`[${label}] ${rest}\n`);
      });
    };
    forward(child.stdout, (text) => process.stdout.write(text));
    forward(child.stderr, (text) => process.stderr.write(text));
    child.on('error', (error) => resolve({ label, code: 1, error, elapsed: performance.now() - startedAt }));
    child.on('close', (code) => resolve({ label, code: code ?? 1, elapsed: performance.now() - startedAt }));
  });

const seconds = (ms) => (ms / 1000).toFixed(1);

let failed = false;
for (const [index, stage] of STAGES.entries()) {
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
