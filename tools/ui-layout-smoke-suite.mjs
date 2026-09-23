import { spawn } from 'node:child_process';
import path from 'node:path';
import { openChromeSession } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 8765;
const debugPort = 9222;

const LAYOUT_GPU_ARGS = [
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
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`layout smoke ${scenario.label} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

let session;
try {
  session = await openChromeSession({
    serveDir: path.join(root, 'docs'),
    port,
    debugPort,
    profilePrefix: 'tepui-layout-suite-',
    extraLaunchArgs: LAYOUT_GPU_ARGS,
  });
  for (const scenario of scenarios) {
    console.log(`layout smoke: ${scenario.label}`);
    await runScenario(session.baseUrl, scenario);
  }
  console.log('UI layout smoke suite passed with one shared Chrome process.');
} finally {
  await session?.close();
}
