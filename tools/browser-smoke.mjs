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

function connectDevTools(url, onEvent) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    if (!response.id) {
      onEvent(response);
      return;
    }
    if (!pending.has(response.id)) return;
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
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    evaluate(expression) {
      return this.send('Runtime.evaluate', { expression, returnByValue: true });
    },
    close: () => socket.close(),
  };
}

const chrome = findChrome();
const debugPort = 9222;
const query = process.env.SMOKE_QUERY ?? '?stage=00';
if (!query.startsWith('?') || query.includes('#')) {
  throw new Error('SMOKE_QUERY must be a query string beginning with "?" and must not contain a fragment.');
}
const expectCreative = new URLSearchParams(query.slice(1)).get('mode') === 'creative';
const profile = mkdtempSync(path.join(tmpdir(), 'tepui-smoke-'));
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', 'docs'], {
  cwd: root,
  stdio: 'ignore',
});
let browser;
let devTools;
const fatalEvents = [];

try {
  const url = `http://127.0.0.1:${port}/${query}`;
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
    'about:blank',
  ], { stdio: 'ignore' });

  devTools = connectDevTools(await waitForDebugPage(debugPort), (event) => {
    if (event.method === 'Runtime.exceptionThrown') fatalEvents.push(event);
    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') fatalEvents.push(event);
    if (event.method === 'Inspector.targetCrashed') fatalEvents.push(event);
  });
  await devTools.opened;
  await devTools.send('Runtime.enable');
  await devTools.send('Page.enable');
  await devTools.send('Inspector.enable');
  await devTools.send('Page.navigate', { url });
  let state;
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await devTools.evaluate(`({
      ready: document.documentElement.dataset.gameReady === 'true',
      fatal: Boolean(document.getElementById('fatal-error-overlay')),
      fatalText: document.getElementById('fatal-error-overlay')?.textContent ?? '',
      creativeZeroShipOverview: Boolean(document.getElementById('hud-shipplacer'))
        && getComputedStyle(document.getElementById('hud-shipplacer')).display !== 'none'
        && getComputedStyle(document.getElementById('hud-overview-camera')).display !== 'none'
        && getComputedStyle(document.getElementById('hud-status')).display === 'none'
    })`);
    state = result.result.value;
    if (state.fatal) throw new Error(`Fatal error overlay appeared during browser smoke test: ${state.fatalText}`);
    if (state.ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state?.ready) throw new Error('Game did not complete 60 animation frames within 30 seconds.');
  if (fatalEvents.length > 0) {
    throw new Error(`Browser reported ${fatalEvents.length} page exception(s) or console error(s).`);
  }
  if (expectCreative && !state.creativeZeroShipOverview) {
    throw new Error('Creative mode did not remain in its zero-ship overview state.');
  }
  const mode = expectCreative ? 'creative zero-ship overview' : query;
  console.log(`Browser smoke passed (${mode}): production build completed 60 frames without page/console fatal errors.`);
} finally {
  devTools?.close();
  if (browser) {
    browser.kill('SIGTERM');
    await Promise.race([once(browser, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  server.kill('SIGTERM');
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
