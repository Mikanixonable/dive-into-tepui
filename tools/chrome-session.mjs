// ヘッドレス Chrome のセッション。静的配信・Chrome の探索と起動・CDP 接続・後片付けまでを
// 一式で持つ。browser-smoke.mjs / perf-probe.mjs / render-lab-shot.mjs は openChromeSession()
// を開いて、それぞれの検証・計測・撮影だけを書く。
import { accessSync, constants, mkdtempSync, rmSync, createReadStream, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const candidates = [
  process.env.CHROME_PATH,
  'google-chrome',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
].filter(Boolean);

// PATH 上の名前と絶対パスの両方を受ける。名前の解決だけは OS ごとのコマンドに委ねる。
function findChrome() {
  const lookup = process.platform === 'win32'
    ? (name) => spawnSync('where', [name], { encoding: 'utf8' })
    : (name) => spawnSync('sh', ['-c', 'command -v "$1"', 'find-chrome', name], { encoding: 'utf8' });
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    const found = lookup(candidate);
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error('Chrome/Chromium not found. Set CHROME_PATH.');
}

// ビルド済みの成果物を配るだけの静的サーバ。検証の連鎖に Node 以外の実行環境を持ち込まない。
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.epk': 'application/octet-stream',
};
function startStaticServer(directory, listenPort) {
  const server = createServer((request, response) => {
    const rel = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = path.join(directory, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(directory)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const size = statSync(file).size;
      response.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': size,
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(listenPort, '127.0.0.1');
  return server;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server startup race; retry briefly.
    }
    await sleep(100);
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
    await sleep(100);
  }
  throw new Error('Chrome DevTools endpoint did not become ready.');
}

// 1リクエストの待ち時間の上限。ページのレンダラが落ちるとその接続宛の応答は二度と返らないので、
// 上限が無いと待ち続けて呼び出し側がそこで永久に止まる(実際に止まった)。重い条件では
// 1フレームが1秒を超えるため、フレーム数十回ぶんの余裕を見る。
const REQUEST_TIMEOUT_MS = 60_000;

function connectDevTools(url, onEvent) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  // 待っている全リクエストを失敗させる。接続が死んだ後に個々のタイムアウトを待たせない。
  const failAll = (reason) => {
    for (const [id, { reject, timer }] of pending) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(reason));
    }
  };
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(event.data);
    if (!response.id) {
      onEvent(response);
      // レンダラが落ちた時点で、この接続宛の応答はもう返らない。
      if (response.method === 'Inspector.targetCrashed') failAll('Renderer target crashed.');
      return;
    }
    if (!pending.has(response.id)) return;
    const { resolve, reject, timer } = pending.get(response.id);
    clearTimeout(timer);
    pending.delete(response.id);
    if (response.error) reject(new Error(response.error.message));
    else resolve(response.result);
  });
  socket.addEventListener('close', () => failAll('Chrome DevTools WebSocket closed.'), { once: true });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools WebSocket failed.')), { once: true });
  });
  return {
    opened,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms: ${method}`));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    },
    // ページ側の式を評価し、その値そのものを返す(result.result.value の掘り下げを毎回書かない)。
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Page evaluation threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

// 接続が死んでも続けられるように、張り直せる接続として扱う。レンダラが落ちるとその接続宛の
// 応答は返らなくなるが、Chrome 自体は生きていて新しいページ target を持つので、target を
// 取り直して繋ぎ直せば残りは続けられる。
async function attachSession(debugPort, onEvent, windowSize) {
  let current = null;
  const attach = async () => {
    const devTools = connectDevTools(await waitForDebugPage(debugPort), onEvent);
    await devTools.opened;
    await devTools.send('Runtime.enable');
    await devTools.send('Page.enable');
    await devTools.send('Inspector.enable');
    if (windowSize !== null) {
      await devTools.send('Emulation.setDeviceMetricsOverride', { ...windowSize, deviceScaleFactor: 1, mobile: false });
    }
    current = devTools;
  };
  await attach();
  return {
    send: (method, params) => current.send(method, params),
    evaluate: (expression) => current.evaluate(expression),
    async reconnect() {
      current?.close();
      await attach();
    },
    close: () => current?.close(),
  };
}

const LAUNCH_ARGS = [
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
  '--mute-audio',
];

// serveDir を port で配り、ヘッドレス Chrome を上げ、CDP を繋いだ状態を返す。
// windowSize({width,height})を渡すと、その大きさの窓と等倍の device metrics で開く。
// onEvent には CDP のイベントがそのまま流れる。close() で接続・ブラウザ・サーバ・
// プロファイルを畳む。
export async function openChromeSession({
  serveDir, port, debugPort, profilePrefix, windowSize = null, onEvent = () => {},
}) {
  const chrome = findChrome();
  const profile = mkdtempSync(path.join(tmpdir(), profilePrefix));
  const server = startStaticServer(serveDir, port);
  const baseUrl = `http://127.0.0.1:${port}`;
  let browser;
  try {
    await waitForServer(`${baseUrl}/`);
    browser = spawn(chrome, [
      ...LAUNCH_ARGS,
      ...(windowSize === null ? [] : [`--window-size=${windowSize.width},${windowSize.height}`, '--force-device-scale-factor=1']),
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await attachSession(debugPort, onEvent, windowSize);
    return {
      devTools,
      baseUrl,
      async close() {
        devTools.close();
        browser.kill('SIGTERM');
        await Promise.race([once(browser, 'exit'), sleep(2_000)]);
        server.close();
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      },
    };
  } catch (e) {
    browser?.kill('SIGTERM');
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw e;
  }
}
