// 複数の子プロセスを同時に走らせ、各行へ [label] を付けて標準出力/標準エラーへ流す
// 共用ランナー。run-ci.mjs(段内の検査)と protein-builder/run-all.mjs(蛋白ごとの
// 処理)が使う。resolve される値には {label, code, error?, elapsed} が入る。
import { spawn } from 'node:child_process';

export function runTask({ label, command, args, cwd }) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
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
}
