import { spawn } from 'node:child_process';

const MAX_ATTEMPTS = 3;
const suite = process.argv.includes('--suite');
const RETRYABLE = [
  "Failed to execute 'createBuffer' on 'GPUDevice'",
  'Instance dropped in popErrorScope',
  "Failed to execute 'mapAsync' on 'GPUBuffer'",
];

function runOnce() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/browser-smoke.mjs'], {
      env: suite ? { ...process.env, SMOKE_LAYOUT_ONLY: '1', SMOKE_LAYOUT_SUITE: '1' } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const forward = (stream) => (chunk) => {
      const text = chunk.toString();
      output += text;
      stream.write(text);
    };
    child.stdout.on('data', forward(process.stdout));
    child.stderr.on('data', forward(process.stderr));
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = await runOnce();
  if (result.code === 0) process.exit(0);

  const retryable = RETRYABLE.some((fragment) => result.output.includes(fragment));
  if (!retryable || attempt === MAX_ATTEMPTS) process.exit(result.code);

  console.error(`layout smoke: retrying known headless WebGPU bootstrap failure (${attempt}/${MAX_ATTEMPTS})`);
}

process.exit(1);
