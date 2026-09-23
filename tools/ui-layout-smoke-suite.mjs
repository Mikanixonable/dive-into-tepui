import { spawn } from 'node:child_process';
import path from 'node:path';
import { openChromeSession } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 8765;
const debugPort = 9222;
const maxAttempts = 3;

const retryableGpuErrors = [
  "Failed to execute 'createBuffer' on 'GPUDevice'",
  'Instance dropped in popErrorScope',
  "Failed to execute 'mapAsync' on 'GPUBuffer'",
];

const layoutGpuArgs = [
  '--use-webgpu-adapter=swiftshader',
  '--enable-features=Vulkan',
  '--use-gpu-in-tests',
  '--enable-accelerated-2d-canvas',
  '--disable-dawn-features=disallow_unsafe_apis',
  '--enable-webgpu-developer-features',
];

const scenarios = [
  { label: 'combat', env: { SMOKE_QUERY: '?stage=00' } },
  { label: 'map', env: { SMOKE_QUERY: '?stage=creative' } },
  {
    label: 'construction',
    env: {
      SMOKE_QUERY: '?stage=creative',
      SMOKE_CREATIVE_PRESET: 'base',
      SMOKE_CONSTRUCTION: '1',
    },
  },
];

function openSharedSession() {
  return openChromeSession({
    serveDir: path.join(root, 'docs'),
    port,
    debugPort,
    profilePrefix: 'tepui-layout-suite-',
    extraLaunchArgs: layoutGpuArgs,
  });
}

function runScenario(baseUrl, scenario) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.SMOKE_QUERY;
    delete env.SMOKE_CREATIVE_PRESET;
    delete env.SMOKE_CONSTRUCTION;
    Object.assign(env, scenario.env, {
      SMOKE_LAYOUT_ONLY: '1',
      SMOKE_REUSE_SESSION: '1',
      SMOKE_BASE_URL: baseUrl,
    });

    const child = spawn(process.execPath, ['tools/browser-smoke.mjs'], {
      cwd: root,
      env,
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
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
}

let session;
try {
  session = await openSharedSession();
  for (const scenario of scenarios) {
    console.log(`layout smoke: ${scenario.label}`);
    let passed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await runScenario(session.baseUrl, scenario);
      if (result.code === 0) {
        passed = true;
        break;
      }

      const retryable = retryableGpuErrors.some((fragment) => result.output.includes(fragment));
      if (!retryable || attempt === maxAttempts) {
        throw new Error(`layout smoke ${scenario.label} failed (${result.signal ?? `exit ${result.code}`})`);
      }

      console.error(
        `layout smoke: restarting shared Chrome after known headless WebGPU failure (${attempt}/${maxAttempts})`,
      );
      await session.close();
      session = await openSharedSession();
    }
    if (!passed) throw new Error(`layout smoke ${scenario.label} exhausted retries`);
  }
  console.log('UI layout smoke suite passed with one shared Chrome process.');
} finally {
  await session?.close();
}
