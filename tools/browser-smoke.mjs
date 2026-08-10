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
const emulateTouch = process.env.SMOKE_TOUCH === '1';
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
  if (emulateTouch) await devTools.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
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
  const dockToggleState = await devTools.evaluate(`[...document.querySelectorAll('.dock-toggle')]
    .map((el) => getComputedStyle(el).display !== 'none')`);
  const togglesVisible = dockToggleState.result.value;
  if (togglesVisible.length !== 2 || togglesVisible.some((visible) => visible !== expectCreative)) {
    throw new Error(`Dock toggle visibility did not match ${expectCreative ? 'map' : 'combat'} mode: ${JSON.stringify(togglesVisible)}`);
  }
  if (!expectCreative) {
    const viewports = [[1280, 720], [800, 600], [480, 800], [320, 568], [667, 375]];
    for (const [width, height] of viewports) {
      await devTools.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width <= 480,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await devTools.evaluate(`(() => {
        const visible = (el) => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
        const rect = (el) => { const r = el.getBoundingClientRect(); return { id: el.id, left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height }; };
        const overlaps = (a,b) => a.left < b.right-.5 && b.left < a.right-.5 && a.top < b.bottom-.5 && b.top < a.bottom-.5;
        const ids = ['hud-status','hud-orbit','hud-target','hud-enemies','hud-stagestatus','hud-context','navball','hud-chase-reset',
          'touch-pad-move','touch-pad-rot','touch-mode-col','touch-fire','touch-zoom','touch-util'];
        const items = ids.map((id) => document.getElementById(id)).filter(visible).map(rect);
        const byId = Object.fromEntries(items.map((item) => [item.id,item]));
        const errors = [];
        for (const item of items) {
          const inScrollableShelf = innerWidth <= 900 && ['hud-status','hud-orbit','hud-target','hud-enemies'].includes(item.id);
          if (!inScrollableShelf && (item.left < -.5 || item.top < -.5 || item.right > innerWidth+.5 || item.bottom > innerHeight+.5)) errors.push('outside viewport: '+item.id);
        }
        const shelfRect = rect(document.getElementById('hud-combat-shelf'));
        if (innerWidth <= 900 && (shelfRect.left < -.5 || shelfRect.right > innerWidth+.5 || shelfRect.top < -.5 || shelfRect.bottom > innerHeight+.5)) errors.push('combat shelf outside viewport');
        const shelfPanels = ['hud-status','hud-orbit','hud-target','hud-enemies'].map((id)=>byId[id]).filter(Boolean);
        if (innerWidth <= 900) {
          const stage = byId['hud-stagestatus'];
          for (const panel of shelfPanels) if (stage && overlaps(stage,panel)) errors.push('stage overlaps '+panel.id);
        } else {
          for (let i=0;i<shelfPanels.length;i++) for(let j=i+1;j<shelfPanels.length;j++) {
            if (overlaps(shelfPanels[i],shelfPanels[j])) errors.push(shelfPanels[i].id+' overlaps '+shelfPanels[j].id);
          }
        }
        const nav = byId['navball']; const reset = byId['hud-chase-reset'];
        if (nav && reset && overlaps(nav,reset)) errors.push('navball overlaps reset');
        for (const panel of shelfPanels) if (nav && overlaps(nav,panel)) errors.push('navball overlaps '+panel.id);
        const touchIds = ['touch-pad-move','touch-pad-rot','touch-mode-col','touch-fire','touch-zoom','touch-util'];
        const touch = touchIds.map((id)=>byId[id]).filter(Boolean);
        for (const panel of shelfPanels) for (const control of touch) if (overlaps(panel,control)) errors.push(panel.id+' overlaps '+control.id);
        for (const control of touch) if (nav && overlaps(nav,control)) errors.push('navball overlaps '+control.id);
        for (const control of touch) if (reset && overlaps(reset,control)) errors.push('reset overlaps '+control.id);
        for (let i=0;i<touch.length;i++) for(let j=i+1;j<touch.length;j++) {
          if (overlaps(touch[i],touch[j])) errors.push(touch[i].id+' overlaps '+touch[j].id);
        }
        const hint = document.getElementById('hud-hint');
        if (hint) { hint.style.opacity='1'; const h=rect(hint); for(const panel of [...shelfPanels,byId['hud-stagestatus']].filter(Boolean)) if(overlaps(h,panel)) errors.push('hint overlaps '+panel.id); hint.style.opacity='0'; }
        return { errors, items };
      })()`);
      const layout = result.result.value;
      if (layout.errors.length) throw new Error(`Combat layout failed at ${width}x${height}: ${layout.errors.join('; ')}; items=${JSON.stringify(layout.items)}`);
    }
    await devTools.send('Emulation.clearDeviceMetricsOverride');

    if (emulateTouch) {
      const zoomArmed = await devTools.evaluate(`(() => {
        const zoom = document.getElementById('touch-zoom');
        if (!zoom) return false;
        zoom.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71 }));
        return zoom.classList.contains('held');
      })()`);
      if (!zoomArmed.result.value) throw new Error('Could not arm touch ZOOM before modal release check.');
    }
    await devTools.send('Input.dispatchKeyEvent', { type:'keyDown', key:'h', code:'KeyH', windowsVirtualKeyCode:72 });
    await devTools.send('Input.dispatchKeyEvent', { type:'keyUp', key:'h', code:'KeyH', windowsVirtualKeyCode:72 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const helpState = await devTools.evaluate(`(() => {
      const shield = document.getElementById('hud-modal-shield');
      const canvas = document.querySelector('canvas');
      let shieldEvents = 0;
      let backgroundEvents = 0;
      shield?.addEventListener('pointerdown', () => { shieldEvents++; });
      canvas?.addEventListener('pointerdown', () => { backgroundEvents++; });
      const target = document.elementFromPoint(window.innerWidth - 2, window.innerHeight - 2);
      target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 }));
      return {
        open: getComputedStyle(document.getElementById('hud-help')).display !== 'none',
        modal: document.body.classList.contains('hud-modal-open'),
        shield: getComputedStyle(shield).pointerEvents === 'auto',
        shieldTarget: target === shield,
        shieldEvent: shieldEvents === 1,
        backgroundEvent: backgroundEvents === 0,
        touchHidden: !document.getElementById('touch-ui') || getComputedStyle(document.getElementById('touch-ui')).display === 'none',
        zoomReleased: !document.getElementById('touch-zoom') || !document.getElementById('touch-zoom').classList.contains('held'),
      };
    })()`);
    if (!Object.values(helpState.result.value).every(Boolean)) throw new Error(`Help modal shielding failed: ${JSON.stringify(helpState.result.value)}`);
    await devTools.send('Input.dispatchKeyEvent', { type:'keyDown', key:'h', code:'KeyH', windowsVirtualKeyCode:72 });
    await devTools.send('Input.dispatchKeyEvent', { type:'keyUp', key:'h', code:'KeyH', windowsVirtualKeyCode:72 });
    await devTools.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await devTools.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const settingsState = await devTools.evaluate(`(() => {
      const shield = document.getElementById('hud-modal-shield');
      const canvas = document.querySelector('canvas');
      let shieldEvents = 0;
      let backgroundEvents = 0;
      shield?.addEventListener('pointerdown', () => { shieldEvents++; });
      canvas?.addEventListener('pointerdown', () => { backgroundEvents++; });
      const target = document.elementFromPoint(window.innerWidth - 2, window.innerHeight - 2);
      target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 }));
      return {
        open: getComputedStyle(document.getElementById('hud-settings')).display !== 'none',
        modal: document.body.classList.contains('hud-modal-open'),
        shield: getComputedStyle(shield).pointerEvents === 'auto',
        shieldTarget: target === shield,
        shieldEvent: shieldEvents === 1,
        backgroundEvent: backgroundEvents === 0,
        touchHidden: !document.getElementById('touch-ui') || getComputedStyle(document.getElementById('touch-ui')).display === 'none',
      };
    })()`);
    if (!Object.values(settingsState.result.value).every(Boolean)) throw new Error(`Settings modal shielding failed: ${JSON.stringify(settingsState.result.value)}`);
  }
  if (expectCreative) {
    const viewports = [
      [1280, 720], [800, 600], [480, 800], [320, 568], [667, 375],
    ];
    for (const [width, height] of viewports) {
      await devTools.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width <= 480,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await devTools.evaluate(`(() => {
        const visible = (el) => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        };
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5
          && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const docks = [...document.querySelectorAll('.hud-dock')].map(rect);
        const panels = [...document.querySelectorAll('.hud-dock > .panel')].filter(visible).map(rect);
        const context = document.getElementById('hud-context');
        const contextRect = context && visible(context) ? rect(context) : null;
        const touchUtil = document.getElementById('touch-util');
        const touchRect = touchUtil && visible(touchUtil) ? rect(touchUtil) : null;
        const plan = panels.find((p) => p.id === 'hud-plan');
        const navball = document.getElementById('navball');
        const navballRect = navball && visible(navball) ? rect(navball) : null;
        const errors = [];
        for (const d of docks) {
          if (d.left < -0.5 || d.right > innerWidth + 0.5 || d.top < -0.5 || d.bottom > innerHeight + 0.5) {
            errors.push('dock outside viewport: ' + JSON.stringify(d));
          }
        }
        if (docks.length === 2 && overlaps(docks[0], docks[1])) errors.push('left/right docks overlap');
        if (contextRect && plan && overlaps(contextRect, plan)) errors.push('context overlaps maneuver plan');
        if (!navballRect || navball?.parentElement?.id !== 'hud-dock-left') errors.push('navball is not visible in left map dock');
        else if (navballRect.left < -.5 || navballRect.right > innerWidth+.5) errors.push('map navball horizontal overflow');
        if (touchRect) {
          for (const dock of docks) if (overlaps(touchRect, dock)) errors.push('touch utility row overlaps dock');
          if (touchRect.left < -0.5 || touchRect.right > innerWidth + 0.5 || touchRect.bottom > innerHeight + 0.5) {
            errors.push('touch utility row outside viewport');
          }
        }
        for (const p of panels) {
          if (p.left < -0.5 || p.right > innerWidth + 0.5 || p.width > innerWidth + 0.5) {
            errors.push('panel horizontal overflow: ' + JSON.stringify(p));
          }
        }
        for (const dockEl of document.querySelectorAll('.hud-dock')) {
          const children = [...dockEl.children].filter(visible);
          if (dockEl.scrollHeight > dockEl.clientHeight && children.length > 0) {
            dockEl.scrollTop = dockEl.scrollHeight;
            const dockRect = dockEl.getBoundingClientRect();
            const lastRect = children.at(-1).getBoundingClientRect();
            if (lastRect.bottom > dockRect.bottom + 1) errors.push('dock cannot scroll to final panel: ' + dockEl.id);
            dockEl.scrollTop = 0;
          }
        }
        return { errors, docks, panels, contextRect, touchRect };
      })()`);
      const layout = result.result.value;
      if (layout.errors.length > 0) {
        throw new Error(`Layout check failed at ${width}x${height}: ${layout.errors.join('; ')}; docks=${JSON.stringify(layout.docks)}`);
      }
      {
        const collapsed = await devTools.evaluate(`(() => {
          const buttons = [...document.querySelectorAll('.dock-toggle')];
          buttons.forEach((button) => button.click());
          const docks = [...document.querySelectorAll('.hud-dock')];
          const hidden = docks.every((dock) => dock.classList.contains('collapsed')
            && [...dock.querySelectorAll(':scope > .panel')].every((panel) => getComputedStyle(panel).display === 'none'));
          const zeroWidth = docks.every((dock) => dock.getBoundingClientRect().width === 0);
          buttons.forEach((button) => button.click());
          const restored = docks.every((dock) => !dock.classList.contains('collapsed') && dock.getBoundingClientRect().width > 0);
          return { count: buttons.length, hidden, zeroWidth, restored };
        })()`);
        const value = collapsed.result.value;
        if (value.count !== 2 || !value.hidden || !value.zeroWidth || !value.restored) {
          throw new Error(`Dock collapse check failed at ${width}x${height}: ${JSON.stringify(value)}`);
        }
      }
    }
    await devTools.send('Emulation.clearDeviceMetricsOverride');

    const placedForMenu = await devTools.evaluate(`(() => {
      const panel = document.getElementById('hud-shipplacer');
      const button = [...(panel?.querySelectorAll('.seg-btn') ?? [])].find((b) => b.textContent?.trim() === '配置');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!placedForMenu.result.value) throw new Error('Could not place a ship for map interaction checks.');
    await new Promise((resolve) => setTimeout(resolve, 200));

    await devTools.evaluate(`[...document.querySelectorAll('.dock-toggle')].forEach((button) => button.click())`);
    await devTools.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 });
    await devTools.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closedDockState = await devTools.evaluate(`(() => {
      const docks = [...document.querySelectorAll('.hud-dock')];
      const buttons = [...document.querySelectorAll('.dock-toggle')];
      return {
        mapMode: document.getElementById('hud').classList.contains('map-mode'),
        collapsed: docks.some((dock) => dock.classList.contains('collapsed')),
        expanded: buttons.every((button) => button.getAttribute('aria-expanded') === 'true'),
        glyphs: buttons.map((button) => button.textContent),
        visible: buttons.some((button) => getComputedStyle(button).display !== 'none'),
      };
    })()`);
    const closed = closedDockState.result.value;
    if (closed.mapMode || closed.collapsed || !closed.expanded || closed.visible
      || JSON.stringify(closed.glyphs) !== JSON.stringify(['◀', '▶'])) {
      throw new Error(`Dock state did not reset on map close: ${JSON.stringify(closed)}`);
    }
    await devTools.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 });
    await devTools.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reopenedDockState = await devTools.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.dock-toggle')];
      return {
        mapMode: document.getElementById('hud').classList.contains('map-mode'),
        collapsed: [...document.querySelectorAll('.hud-dock')].some((dock) => dock.classList.contains('collapsed')),
        expanded: buttons.every((button) => button.getAttribute('aria-expanded') === 'true'),
        glyphs: buttons.map((button) => button.textContent),
        visible: buttons.every((button) => getComputedStyle(button).display !== 'none'),
      };
    })()`);
    const reopened = reopenedDockState.result.value;
    if (!reopened.mapMode || reopened.collapsed || !reopened.expanded || !reopened.visible
      || JSON.stringify(reopened.glyphs) !== JSON.stringify(['◀', '▶'])) {
      throw new Error(`Dock state did not remain synchronized after reopening map: ${JSON.stringify(reopened)}`);
    }

    let menuOpened = false;
    await devTools.evaluate(`(() => {
      const moon = [...document.querySelectorAll('#hud-overview-camera .seg-btn')]
        .find((button) => button.textContent?.includes('月'));
      moon?.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (let attempt = 0; attempt < 20 && !menuOpened; attempt++) {
      const candidates = await devTools.evaluate(`[...document.querySelectorAll('.mk-poi')]
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })
        .filter((p) => p.x >= 0 && p.x <= innerWidth && p.y >= 0 && p.y <= innerHeight)`);
      for (const point of candidates.result.value) {
        await devTools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
        await devTools.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1 });
        await devTools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const opened = await devTools.evaluate(`[...document.querySelectorAll('.ctx-menu')]
          .some((el) => getComputedStyle(el).display !== 'none')`);
        if (opened.result.value) { menuOpened = true; break; }
      }
      if (!menuOpened) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!menuOpened) {
      const diagnostics = await devTools.evaluate(`({
        markers: [...document.querySelectorAll('.mk-poi')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => {
          const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y); return { id: el.id, x, y, hit: hit?.tagName + '#' + hit?.id };
        }),
        canvases: [...document.querySelectorAll('canvas')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, x: r.x, y: r.y, w: r.width, h: r.height }; })
      })`);
      throw new Error(`Context menu did not open from any visible map marker: ${JSON.stringify(diagnostics.result.value)}`);
    }
    await devTools.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 568, deviceScaleFactor: 1, mobile: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const menuLayout = await devTools.evaluate(`(() => {
      const menu = [...document.querySelectorAll('.ctx-menu')].find((el) => getComputedStyle(el).display !== 'none');
      if (!menu) return { open: false };
      const r = menu.getBoundingClientRect();
      return { open: true, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
    })()`);
    if (!menuLayout.result.value.open || !menuLayout.result.value.inside) {
      throw new Error(`Context menu did not remain clamped after resize: ${JSON.stringify(menuLayout.result.value)}`);
    }
    await devTools.send('Emulation.clearDeviceMetricsOverride');
  }
  if (expectCreative && process.env.SMOKE_CREATIVE_PLACE === '2') {
    await devTools.evaluate(`(() => {
      const panel = document.getElementById('hud-shipplacer');
      const button = [...(panel?.querySelectorAll('.seg-btn') ?? [])].find((b) => b.textContent?.trim() === '配置');
      if (!button) throw new Error('Creative placement button not found.');
      button.click();
      button.click();
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await devTools.evaluate(`({ fatal: Boolean(document.getElementById('fatal-error-overlay')), text: document.getElementById('fatal-error-overlay')?.textContent ?? '' })`);
    if (after.result.value.fatal) throw new Error(`Creative second placement failed: ${after.result.value.text}`);
    if (fatalEvents.length > 0) throw new Error(`Creative second placement reported ${fatalEvents.length} page exception(s).`);
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
