import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = 8765;
const candidates = [
  process.env.CHROME_PATH,
  'google-chrome',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    const found = spawnSync('sh', ['-c', 'command -v "$1"', 'find-chrome', candidate], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_PATH to run the browser smoke test.');
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server startup race; retry briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Static server did not become ready: ${url}`);
}

async function waitForDebugPage(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = pages.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome startup race; retry briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not become ready.');
}

function connectDevTools(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    if (!response.id || !pending.has(response.id)) return;
    const { resolve, reject } = pending.get(response.id);
    pending.delete(response.id);
    if (response.error) reject(new Error(response.error.message));
    else resolve(response.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools WebSocket failed.')), { once: true });
  });
  return {
    opened,
    evaluate(expression) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => socket.close(),
  };
}

const chrome = findChrome();
const debugPort = 9222;
const profile = mkdtempSync(path.join(tmpdir(), 'tepui-smoke-'));
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', 'docs'], {
  cwd: root,
  stdio: 'ignore',
});
let browser;
let devTools;

try {
  const url = `http://127.0.0.1:${port}/?stage=00`;
  await waitForServer(url);
  browser = spawn(chrome, [
    '--headless=new',
    '--no-proxy-server',
    '--enable-gpu',
    '--enable-unsafe-webgpu',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--run-all-compositor-stages-before-draw',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    url,
  ], { stdio: 'ignore' });

  devTools = connectDevTools(await waitForDebugPage(debugPort));
  await devTools.opened;
  let state;
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await devTools.evaluate(`({
      ready: document.documentElement.dataset.gameReady === 'true',
      fatal: Boolean(document.getElementById('fatal-error-overlay')),
      fatalText: document.getElementById('fatal-error-overlay')?.textContent ?? ''
    })`);
    state = result.result.value;
    if (state.fatal) throw new Error(`Fatal error overlay appeared during browser smoke test: ${state.fatalText}`);
    if (state.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state?.ready) throw new Error('Game did not complete 60 animation frames within 30 seconds.');
  console.log('Browser smoke passed: production build completed 60 frames without a fatal overlay.');
} finally {
  devTools?.close();
  if (browser) {
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  server.kill('SIGTERM');
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
