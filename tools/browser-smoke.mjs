import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const port = 8765;
const debugPort = 9222;
const query = process.env.SMOKE_QUERY ?? '?stage=00';
if (!query.startsWith('?') || query.includes('#')) {
  throw new Error('SMOKE_QUERY must be a query string beginning with "?" and must not contain a fragment.');
}
const expectCreative = new URLSearchParams(query.slice(1)).get('stage') === 'creative';
const creativePreset = process.env.SMOKE_CREATIVE_PRESET ?? 'combat';
if (creativePreset !== 'combat' && creativePreset !== 'base') {
  throw new Error('SMOKE_CREATIVE_PRESET must be either "combat" or "base".');
}
const smokeConstruction = process.env.SMOKE_CONSTRUCTION === '1';
if (smokeConstruction && (!expectCreative || creativePreset !== 'base')) {
  throw new Error('SMOKE_CONSTRUCTION=1 requires creative stage and base preset.');
}
const emulateTouch = process.env.SMOKE_TOUCH === '1';
const layoutOnly = process.env.SMOKE_LAYOUT_ONLY === '1';
let session;
let devTools;
const fatalEvents = [];

// レイアウト検査でページ側に置く共通ヘルパ。視認できるか・矩形・重なりの3つだけ。
const LAYOUT_HELPERS = `
  const visible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5
    && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const insideViewport = (r) => r.left >= -0.5 && r.top >= -0.5
    && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
  const tinyInteractiveText = (scope = document) => [...scope.querySelectorAll('.w-btn, button, input, select')]
    .filter(visible)
    .filter((el) => !el.classList.contains('ui-icon-control'))
    .filter((el) => el.tagName === 'INPUT' || el.tagName === 'SELECT' || (el.textContent?.trim().length ?? 0) > 0)
    .map((el) => ({ tag: el.tagName, id: el.id, text: el.textContent?.trim().slice(0, 32) ?? '', size: parseFloat(getComputedStyle(el).fontSize) }))
    .filter((item) => Number.isFinite(item.size) && item.size < 10);
`;

async function pressKey(key, code, keyCode) {
  await devTools.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
  await devTools.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}

// 入力はゲーム側の rAF ループが取りに来て初めて効くので、結果は待ち時間ではなく条件で待つ。
// 固定の sleep は、遅い実行環境で「通ったり落ちたり」する検証を作ってしまう。
async function waitFor(expression, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await devTools.evaluate(expression)) return;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

// 仮想パッドは「最初の入力がタッチだった」ことで初めて現れる。SMOKE_TOUCH=1 の検証が
// パッドのレイアウトまで見るには、合成 PointerEvent ではなく本物のタッチが要る。
async function revealTouchPad() {
  const point = { x: 40, y: 40 };
  await devTools.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await devTools.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(
    `document.getElementById('touch-ui')?.classList.contains('shown') === true`,
    'the virtual pad to appear after a touch',
  );
}

async function rightClickAt(x, y) {
  await devTools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await devTools.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
  await devTools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
}

// 全てのキーが真であることを求め、偽が混ざっていればその内訳ごと投げる。
function expectAll(label, state) {
  if (!Object.values(state).every(Boolean)) throw new Error(`${label}: ${JSON.stringify(state)}`);
}

// 収集した例外・console.error を、そのまま原因を追える文言へ畳む。
// 件数だけを報告すると、この検証自体が「何が起きたか分からない」道具になる。
function describeFatalEvents() {
  return fatalEvents.map((event) => {
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params.exceptionDetails;
      return `exception: ${details.exception?.description ?? details.text}`;
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      return `console.error: ${event.params.args.map((arg) => arg.description ?? String(arg.value)).join(' ')}`;
    }
    return `${event.method}: ${JSON.stringify(event.params ?? {})}`;
  }).join('\n  ');
}

function throwIfFatal(label) {
  if (fatalEvents.length > 0) throw new Error(`${label} (${fatalEvents.length}):\n  ${describeFatalEvents()}`);
}

function isIgnorableLayoutGpuEvent(event) {
  if (!layoutOnly) return false;
  if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
    const message = event.params.args.map((arg) => arg.description ?? String(arg.value)).join(' ');
    return message.includes('THREE.Error resolving queries: AbortError')
      && message.includes("Failed to execute 'mapAsync' on 'GPUBuffer'");
  }
  if (event.method === 'Runtime.exceptionThrown') {
    const details = event.params.exceptionDetails;
    const message = details.exception?.description ?? details.text ?? '';
    return message.includes('OperationError: Instance dropped in popErrorScope');
  }
  return false;
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'medium', width: 800, height: 600 },
  { name: 'compact-portrait', width: 480, height: 800 },
  { name: 'compact-narrow', width: 320, height: 568 },
  { name: 'short-landscape', width: 667, height: 375 },
];

async function throwIfVisibleFatalOverlay(label) {
  if (!layoutOnly) return;
  const fatal = await devTools.evaluate(`(() => {
    const el = document.getElementById('fatal-error-overlay');
    if (!el || getComputedStyle(el).display === 'none') return '';
    return el.textContent ?? 'fatal error overlay';
  })()`);
  if (fatal) throw new Error(`${label}: ${fatal}`);
}

async function applyViewport({ width, height }) {
  if (layoutOnly) {
    await devTools.evaluate(`document.documentElement.dataset.layoutSmokeFreeze = 'true'`);
    // rAF側がfreezeを観測してからrendererをリサイズし得るviewport変更を行う。
    await sleep(50);
  }
  await devTools.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width <= 480,
  });
  // CSS media query と ResizeObserver(--hud-*-occupied) の双方が反映されるまで待つ。
  await sleep(100);
  await throwIfVisibleFatalOverlay('Headless GPU fatal during layout viewport check');
}

async function clearViewport() {
  await devTools.send('Emulation.clearDeviceMetricsOverride');
  // 元viewportへ戻す処理もGPU停止中に済ませてから通常描画へ復帰する。
  await sleep(100);
  if (layoutOnly) {
    await devTools.evaluate(`delete document.documentElement.dataset.layoutSmokeFreeze`);
    await sleep(100);
    await throwIfVisibleFatalOverlay('Headless GPU fatal after restoring layout viewport');
  }
}

async function checkOverlayGeometry(selector, label) {
  for (const viewport of VIEWPORTS) {
    await applyViewport(viewport);
    const state = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!visible(el)) return { visible: false, inside: false, tiny: [] };
      return { visible: true, inside: insideViewport(rect(el)), tiny: tinyInteractiveText(el) };
    })()`);
    if (!state.visible || !state.inside || state.tiny.length) {
      throw new Error(`${label} geometry failed at ${viewport.name} ${viewport.width}x${viewport.height}: ${JSON.stringify(state)}`);
    }
  }
  await clearViewport();
}

// 戦闘ビューの常設パネルが、どの画面寸法でも視界の外へ出ず互いに重ならないことを見る。
// 戦闘シェルフは狭い幅で横スクロール領域になるので、その中のパネルはシェルフの
// スクロール内容に収まっていれば良い(視界の外に出ていること自体は正常)。
async function checkCombatLayout() {
  for (const viewport of VIEWPORTS) {
    const { width, height } = viewport;
    await applyViewport(viewport);
    const layout = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const errors = [];
      const combatRoot = document.querySelector('.hud-combat-root.active');
      const shelf = rect(combatRoot);
      if (!insideViewport(shelf)) errors.push('combat root outside viewport');
      const railEls = [...combatRoot.querySelectorAll('.hud-rail')].filter(visible);
      const rails = railEls.map(rect);
      for (const rail of rails) if (!insideViewport(rail)) errors.push('combat rail outside viewport: ' + rail.id);
      const shelfIds = ['hud-vessel-status', 'hud-orbit', 'burn-management-panel', 'hud-enemies', 'hud-target'];
      const shelfPanels = shelfIds.map((id) => document.getElementById(id)).filter(visible).map(rect);
      for (const panel of shelfPanels) {
        if (panel.left < -0.5 || panel.right > innerWidth + 0.5 || panel.width > innerWidth + 0.5) {
          errors.push('combat panel horizontal overflow: ' + panel.id);
        }
      }
      for (const railEl of railEls) {
        const children = [...railEl.children].filter(visible);
        if (railEl.scrollHeight > railEl.clientHeight && children.length > 0) {
          railEl.scrollTop = railEl.scrollHeight;
          const bottom = railEl.getBoundingClientRect().bottom;
          if (children.at(-1).getBoundingClientRect().bottom > bottom + 1) {
            errors.push('combat rail cannot scroll to final panel: ' + railEl.id);
          }
          railEl.scrollTop = 0;
        }
      }
      for (let i = 0; i < shelfPanels.length; i++) {
        for (let j = i + 1; j < shelfPanels.length; j++) {
          if (overlaps(shelfPanels[i], shelfPanels[j])) errors.push(shelfPanels[i].id + ' overlaps ' + shelfPanels[j].id);
        }
      }
      // シェルフ外の常設要素は視界内に収まっていること。
      const floatIds = ['hud-stagestatus', 'hud-topbar', 'hud-chase-reset', 'hud-help-badge'];
      const floating = floatIds.map((id) => document.getElementById(id)).filter(visible).map(rect);
      for (const item of floating) if (!insideViewport(item)) errors.push('outside viewport: ' + item.id);
      // シェルフが画面上端側へ回る幅(breakpoints.ts の MQ_MEDIUM_DOWN)では、
      // 画面下端のステージ状態パネルと衝突しないこと。
      const stage = floating.find((item) => item.id === 'hud-stagestatus');
      if (innerWidth <= 1100 && stage) {
        for (const panel of shelfPanels) {
          const panelEl = document.getElementById(panel.id);
          const railEl = panelEl?.closest('.hud-rail');
          if (!railEl) continue;
          const rail = rect(railEl);
          const visiblePanel = {
            ...panel,
            left: Math.max(panel.left, rail.left),
            right: Math.min(panel.right, rail.right),
            top: Math.max(panel.top, rail.top),
            bottom: Math.min(panel.bottom, rail.bottom),
          };
          if (visiblePanel.left < visiblePanel.right && visiblePanel.top < visiblePanel.bottom
            && overlaps(stage, visiblePanel)) errors.push('stage overlaps visible ' + panel.id);
        }
      }
      // 仮想パッドは初回タッチまで不可視(opacity:0)なので、実際に出ている時だけ見る。
      const touchRoot = document.getElementById('touch-ui');
      if (touchRoot?.classList.contains('shown')) {
        const touch = ['touch-pad-move', 'touch-pad-rot', 'touch-mode-col', 'touch-fire', 'touch-zoom', 'touch-util']
          .map((id) => document.getElementById(id)).filter(visible).map(rect);
        for (const control of touch) if (!insideViewport(control)) errors.push('outside viewport: ' + control.id);
        // 比べるのは戦闘シェルフの3枚だけ。画面下端のステージ状態パネルは、パッドが出ている
        // 限りどの寸法でもモード列(狭い画面では並進・回転パッドも)と重なる既知の崩れがあり、
        // ここで落とすとこの検証が「直っていない既存の崩れ」を報告し続ける道具になってしまう。
        for (const panel of shelfPanels) {
          for (const control of touch) if (overlaps(panel, control)) errors.push(panel.id + ' overlaps ' + control.id);
        }
        for (let i = 0; i < touch.length; i++) {
          for (let j = i + 1; j < touch.length; j++) {
            if (overlaps(touch[i], touch[j])) errors.push(touch[i].id + ' overlaps ' + touch[j].id);
          }
        }
      }
      // ヒントは常時 opacity:0 で、出た瞬間にパネルを覆わないことだけ確かめる。
      const hint = document.getElementById('hud-hint');
      if (hint) {
        hint.style.opacity = '1';
        const h = rect(hint);
        for (const panel of shelfPanels) {
          const panelEl = document.getElementById(panel.id);
          const railEl = panelEl?.closest('.hud-rail');
          if (!railEl) continue;
          const rail = rect(railEl);
          const clipped = {
            ...panel,
            left: Math.max(panel.left, rail.left),
            right: Math.min(panel.right, rail.right),
            top: Math.max(panel.top, rail.top),
            bottom: Math.min(panel.bottom, rail.bottom),
          };
          if (clipped.left < clipped.right && clipped.top < clipped.bottom && overlaps(h, clipped)) {
            errors.push('hint overlaps visible ' + panel.id);
          }
        }
        for (const item of floating) if (overlaps(h, item)) errors.push('hint overlaps ' + item.id);
        hint.style.opacity = '';
      }
      const chrome = document.getElementById('hud-chrome');
      const chromeRect = visible(chrome) ? rect(chrome) : null;
      if (chromeRect) {
        for (const rail of railEls) {
          if (rail.getBoundingClientRect().top < chromeRect.bottom - 1) errors.push('combat rail overlaps HUD chrome: ' + rail.id);
        }
      }
      for (const panel of railEls.flatMap((rail) => [...rail.querySelectorAll(':scope > .panel')].filter(visible))) {
        const overflowY = getComputedStyle(panel).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') errors.push('direct combat rail panel owns vertical scroll: ' + panel.id);
      }
      const tiny = tinyInteractiveText(document.getElementById('hud'));
      if (tiny.length) errors.push('interactive text below 10px: ' + JSON.stringify(tiny));
      return { errors, shelf, rails, shelfPanels, floating, chromeRect, tiny };
    })()`);
    if (layout.errors.length) {
      throw new Error(`Combat layout failed at ${viewport.name} ${width}x${height}: ${layout.errors.join('; ')}; ${JSON.stringify(layout)}`);
    }
  }
  await clearViewport();
}

// マップビューの左右レールが視界に収まり、互いに重ならず、最後のパネルまでスクロールで
// 届くことを見る。レールは縦スクロール領域なので、パネルの縦のはみ出しは正常。
async function checkMapLayout() {
  for (const viewport of VIEWPORTS) {
    const { width, height } = viewport;
    await applyViewport(viewport);
    const layout = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const errors = [];
      const railEls = [...document.querySelectorAll('.hud-map-root.active .hud-rail')];
      const rails = railEls.map(rect);
      for (const rail of rails) if (!insideViewport(rail)) errors.push('rail outside viewport: ' + rail.id);
      if (rails.length !== 2) errors.push('expected two map rails, found ' + rails.length);
      else if (overlaps(rails[0], rails[1])) errors.push('left/right rails overlap');
      const panels = railEls.flatMap((rail) => [...rail.querySelectorAll(':scope > .panel')].filter(visible).map(rect));
      for (const panel of panels) {
        if (panel.left < -0.5 || panel.right > innerWidth + 0.5 || panel.width > innerWidth + 0.5) {
          errors.push('panel horizontal overflow: ' + panel.id);
        }
      }
      for (const rail of railEls) {
        const children = [...rail.children].filter(visible);
        if (rail.scrollHeight > rail.clientHeight && children.length > 0) {
          rail.scrollTop = rail.scrollHeight;
          const bottom = rail.getBoundingClientRect().bottom;
          if (children.at(-1).getBoundingClientRect().bottom > bottom + 1) {
            errors.push('rail cannot scroll to final panel: ' + rail.id);
          }
          rail.scrollTop = 0;
        }
      }
      // 下端中央の PREDICT バーと右下の縮尺バーは視界内。
      for (const id of ['hud-predict-wrap', 'hud-map-scale']) {
        const el = document.getElementById(id);
        if (visible(el) && !insideViewport(rect(el))) errors.push('outside viewport: ' + id);
      }
      const objectList = document.getElementById('hud-physical-object-list');
      const plan = document.getElementById('hud-plan');
      if (visible(objectList) && visible(plan) && overlaps(rect(objectList), rect(plan))) {
        errors.push('object list overlaps maneuver plan');
      }
      const predict = document.getElementById('hud-predict-wrap');
      const predictRect = visible(predict) ? rect(predict) : null;
      if (predictRect) {
        for (const rail of rails) if (overlaps(predictRect, rail)) errors.push('predict overlaps rail: ' + rail.id);
      }
      const chrome = document.getElementById('hud-chrome');
      const chromeRect = visible(chrome) ? rect(chrome) : null;
      if (chromeRect) {
        for (const railEl of railEls) {
          if (railEl.getBoundingClientRect().top < chromeRect.bottom - 1) errors.push('map rail overlaps HUD chrome: ' + railEl.id);
        }
      }
      const root = document.querySelector('.hud-map-root.active');
      const rootRect = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      const occupied = {
        left: parseFloat(style.getPropertyValue('--hud-left-rail-occupied')),
        right: parseFloat(style.getPropertyValue('--hud-right-rail-occupied')),
      };
      const actual = railEls.length === 2 ? {
        left: Math.max(0, Math.ceil(railEls[0].getBoundingClientRect().right - rootRect.left)),
        right: Math.max(0, Math.ceil(rootRect.right - railEls[1].getBoundingClientRect().left)),
      } : { left: NaN, right: NaN };
      if (railEls.length === 2 && Math.abs(occupied.left - actual.left) > 2) errors.push('left occupied token mismatch');
      if (railEls.length === 2 && Math.abs(occupied.right - actual.right) > 2) errors.push('right occupied token mismatch');
      for (const panel of railEls.flatMap((rail) => [...rail.querySelectorAll(':scope > .panel')].filter(visible))) {
        const overflowY = getComputedStyle(panel).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') errors.push('direct map rail panel owns vertical scroll: ' + panel.id);
      }
      const tiny = tinyInteractiveText(document.getElementById('hud'));
      if (tiny.length) errors.push('interactive text below 10px: ' + JSON.stringify(tiny));
      return { errors, rails, panels, predictRect, chromeRect, occupied, actual, tiny };
    })()`);
    if (layout.errors.length) {
      throw new Error(`Map layout failed at ${viewport.name} ${width}x${height}: ${layout.errors.join('; ')}; ${JSON.stringify(layout)}`);
    }
    const collapse = await devTools.evaluate(`(() => {
      const toggles = [...document.querySelectorAll('.hud-map-root.active .rail-toggle')];
      const rails = [...document.querySelectorAll('.hud-map-root.active .hud-rail')];
      toggles.forEach((toggle) => toggle.click());
      const collapsed = rails.every((rail) => rail.classList.contains('collapsed')
        && [...rail.querySelectorAll(':scope > .panel')].every((panel) => getComputedStyle(panel).display === 'none'));
      const zeroWidth = rails.every((rail) => rail.getBoundingClientRect().width === 0);
      toggles.forEach((toggle) => toggle.click());
      const restored = rails.every((rail) => !rail.classList.contains('collapsed') && rail.getBoundingClientRect().width > 0);
      return { count: toggles.length === 2, collapsed, zeroWidth, restored };
    })()`);
    expectAll(`Rail collapse check failed at ${viewport.name} ${width}x${height}`, collapse);
    await sleep(50);
    const occupiedAfterRestore = await devTools.evaluate(`(() => {
      const root = document.querySelector('.hud-map-root.active');
      const style = getComputedStyle(root);
      return {
        left: parseFloat(style.getPropertyValue('--hud-left-rail-occupied')) > 0,
        right: parseFloat(style.getPropertyValue('--hud-right-rail-occupied')) > 0,
      };
    })()`);
    expectAll(`Rail occupied-area contract did not restore at ${viewport.name}`, occupiedAfterRestore);
  }
  await clearViewport();
}

// 全画面モーダル(ヘルプ)は背景の入力を遮り、仮想パッドを隠し、押しっぱなしのタッチ入力を解放する。
async function checkHelpModal() {
  if (emulateTouch) {
    const zoomArmed = await devTools.evaluate(`(() => {
      const zoom = document.getElementById('touch-zoom');
      if (!zoom) return false;
      zoom.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71 }));
      return zoom.classList.contains('pressed');
    })()`);
    if (!zoomArmed) throw new Error('Could not arm touch ZOOM before modal release check.');
  }
  if (layoutOnly) {
    await devTools.evaluate(`document.getElementById('hud-help-badge')?.click()`);
  } else {
    await pressKey('h', 'KeyH', 72);
  }
  await waitFor(
    `getComputedStyle(document.getElementById('hud-help')).display !== 'none'`,
    layoutOnly ? 'the HLP badge to open the help panel' : '[H] to open the help panel',
  );
  await throwIfVisibleFatalOverlay('Headless GPU fatal while checking Help modal');
  const state = await devTools.evaluate(`(() => {
    const shield = document.getElementById('hud-overlay-shield');
    const canvas = document.querySelector('canvas');
    let shieldEvents = 0;
    let backgroundEvents = 0;
    shield?.addEventListener('pointerdown', () => { shieldEvents++; });
    canvas?.addEventListener('pointerdown', () => { backgroundEvents++; });
    const x = window.innerWidth - 2;
    const y = window.innerHeight - 2;
    const target = document.elementFromPoint(x, y);
    target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    return {
      open: getComputedStyle(document.getElementById('hud-help')).display !== 'none',
      modal: document.body.classList.contains('hud-overlay-modal-open'),
      shieldGates: getComputedStyle(shield).pointerEvents === 'auto',
      shieldTarget: target === shield,
      shieldEvent: shieldEvents === 1,
      backgroundEvent: backgroundEvents === 0,
      touchHidden: !document.getElementById('touch-ui') || getComputedStyle(document.getElementById('touch-ui')).display === 'none',
      zoomReleased: !document.getElementById('touch-zoom') || !document.getElementById('touch-zoom').classList.contains('pressed'),
    };
  })()`);
  expectAll('Help modal shielding failed', state);
  await checkOverlayGeometry('#hud-help', 'Help modal');
  if (layoutOnly) {
    await devTools.evaluate(`document.querySelector('#hud-help .w-close')?.click()`);
  } else {
    await pressKey('Escape', 'Escape', 27);
  }
  await waitFor(
    `getComputedStyle(document.getElementById('hud-help')).display === 'none'
      && !document.body.classList.contains('hud-overlay-modal-open')`,
    layoutOnly ? 'the Help close button to close the panel' : 'Escape to close the help panel',
  );
}

// ポーズメニューはモーダルだが背景の入力は遮らない(gatesInput:false)。
// ゲーム世界も暗転させない(UI-DESIGN.md「一時停止タブ」)。どちらも退行しやすいので明示的に見る。
async function checkPauseMenu() {
  await pressKey('Escape', 'Escape', 27);
  await waitFor(`getComputedStyle(document.getElementById('hud-pause-menu')).display !== 'none'`, 'Escape to open the pause menu');
  // ここでは合成 pointerdown を投げない — 背景はゲーム本体のリスナで、合成イベントの
  // pointerId には setPointerCapture が通らず、この検証自身が例外を生んでしまう。
  // 遮っていないことは当たり判定(最前面がシールドでなく背景である)で言い切れる。
  const state = await devTools.evaluate(`(() => {
    const shield = document.getElementById('hud-overlay-shield');
    const x = window.innerWidth - 2;
    const y = window.innerHeight - 2;
    const target = document.elementFromPoint(x, y);
    return {
      open: getComputedStyle(document.getElementById('hud-pause-menu')).display !== 'none',
      modal: document.body.classList.contains('hud-overlay-modal-open'),
      worldNotDimmed: getComputedStyle(shield).display === 'none',
      shieldPasses: getComputedStyle(shield).pointerEvents === 'none',
      backgroundReachable: target !== shield && target?.tagName === 'CANVAS',
      touchHidden: !document.getElementById('touch-ui') || getComputedStyle(document.getElementById('touch-ui')).display === 'none',
    };
  })()`);
  expectAll('Pause menu shielding failed', state);
  await checkOverlayGeometry('#hud-pause-menu', 'Pause menu');
  await pressKey('Escape', 'Escape', 27);
  await waitFor(
    `getComputedStyle(document.getElementById('hud-pause-menu')).display === 'none'`,
    'Escape to close the pause menu',
  );
}

// マップ上のどの天体マーカーにも当たらない画面座標を1つ選ぶ。
// 空域の右クリック(= 配置メニュー)は、マーカーを外すことが前提なので位置を先に決める。
async function findEmptySpacePoint() {
  return devTools.evaluate(`(() => {
    const markers = [...document.querySelectorAll('.mk')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    let best = null;
    for (let x = 40; x < innerWidth - 40; x += 20) {
      for (let y = 40; y < innerHeight - 40; y += 20) {
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        let nearest = Infinity;
        for (const m of markers) nearest = Math.min(nearest, Math.hypot(m.x - x, m.y - y));
        if (!best || nearest > best.nearest) best = { x, y, nearest };
      }
    }
    return best;
  })()`);
}

// 空域メニュー →「オブジェクトを配置する」→ 配置パネルの確定、までを実際に押して通す。
async function placeShipThroughMenu() {
  const point = await findEmptySpacePoint();
  if (!point || point.nearest < 30) {
    throw new Error(`Could not find empty map space to right-click: ${JSON.stringify(point)}`);
  }
  await rightClickAt(point.x, point.y);
  await waitFor(
    `[...document.querySelectorAll('.ctx-menu')].some((el) => getComputedStyle(el).display !== 'none')`,
    `the empty-space context menu at (${point.x}, ${point.y})`,
  );
  const openedPlacer = await devTools.evaluate(`(() => {
    const menu = [...document.querySelectorAll('.ctx-menu')].find((el) => getComputedStyle(el).display !== 'none');
    const item = [...menu.querySelectorAll('.ctx-menu-item')].find((el) => el.textContent?.includes('オブジェクトを配置'));
    if (!item) return 'no placement item: ' + [...menu.querySelectorAll('.ctx-menu-item')].map((e) => e.textContent).join('/');
    item.click();
    return '';
  })()`);
  if (openedPlacer) throw new Error(`Creative placement menu failed: ${openedPlacer}`);
  await waitFor(
    `getComputedStyle(document.getElementById('hud-object-placer')).display !== 'none'`,
    'the placement panel to open',
  );
  if (creativePreset === 'base') {
    const selectedBase = await devTools.evaluate(`(() => {
      const panel = document.getElementById('hud-object-placer');
      const button = [...panel.querySelectorAll('.w-btn')].find((b) => b.textContent?.includes('基地'));
      if (!button) return 'no base preset button';
      button.click();
      return '';
    })()`);
    if (selectedBase) throw new Error(`Creative base preset selection failed: ${selectedBase}`);
    await waitFor(
      `[...document.querySelectorAll('#hud-object-placer .w-btn')]
        .some((b) => b.textContent?.includes('基地') && b.classList.contains('on'))`,
      'the base preset to become selected',
    );
  }
  const confirmed = await devTools.evaluate(`(() => {
    const panel = document.getElementById('hud-object-placer');
    const button = [...panel.querySelectorAll('.w-btn')].find((b) => b.textContent?.startsWith('配置'));
    if (!button) return 'no confirm button: ' + [...panel.querySelectorAll('.w-btn')].map((b) => b.textContent).join('/');
    button.click();
    return '';
  })()`);
  if (confirmed) throw new Error(`Creative placement panel failed: ${confirmed}`);
  await waitFor(
    `getComputedStyle(document.getElementById('hud-object-placer')).display === 'none'`,
    'the placement panel to close after confirming',
  );
}

async function selectConstructionModuleAndPlace(label, expectedCount) {
  const selected = await devTools.evaluate(`(() => {
    const panel = document.getElementById('ship-construction-panel');
    const select = panel?.querySelector('select[aria-label="追加するモジュール"]');
    if (!select) return 'module selector is missing';
    const index = [...select.options].findIndex((option) => option.textContent === ${JSON.stringify(label)});
    if (index < 0) return 'module option is missing: ' + ${JSON.stringify(label)};
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return '';
  })()`);
  if (selected) throw new Error(`Construction module selection failed: ${selected}`);
  await waitFor(
    `(() => {
      const panel = document.getElementById('ship-construction-panel');
      const button = [...panel.querySelectorAll('.construction-actions .w-btn')]
        .find((item) => item.textContent?.trim() === '配置');
      return button && !button.disabled;
    })()`,
    `${label} to become placeable`,
  );
  await devTools.evaluate(`(() => {
    const panel = document.getElementById('ship-construction-panel');
    [...panel.querySelectorAll('.construction-actions .w-btn')]
      .find((item) => item.textContent?.trim() === '配置')?.click();
  })()`);
  await waitFor(
    `document.querySelector('[data-id="construction-count"]')?.textContent === '${expectedCount}'`,
    `${label} placement to update the construction assembly`,
  );
}

async function checkConstructionLayout() {
  for (const viewport of VIEWPORTS) {
    await applyViewport(viewport);
    const state = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const errors = [];
      const workspace = document.getElementById('ship-construction-panel');
      if (!visible(workspace)) errors.push('construction workspace hidden');
      else if (!insideViewport(rect(workspace))) errors.push('construction workspace outside viewport');
      const parts = [
        ...workspace.querySelectorAll('.construction-pane'),
        workspace.querySelector('.construction-center'),
        workspace.querySelector('.construction-mobile-tabs'),
      ].filter(visible);
      const rects = parts.map(rect);
      for (const item of rects) if (!insideViewport(item)) errors.push('construction child outside viewport: ' + (item.id || 'anonymous'));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (overlaps(rects[i], rects[j])) errors.push('construction regions overlap');
        }
      }
      const tiny = tinyInteractiveText(workspace);
      if (tiny.length) errors.push('interactive text below 10px: ' + JSON.stringify(tiny));
      return { errors, rects, tiny };
    })()`);
    if (state.errors.length) {
      throw new Error(`Construction layout failed at ${viewport.name} ${viewport.width}x${viewport.height}: ${state.errors.join('; ')}; ${JSON.stringify(state)}`);
    }
  }
  await clearViewport();
}

async function constructMaterialFromBaseDock() {
  await devTools.evaluate(`(() => {
    const title = [...document.querySelectorAll('.property-window .prop-window-related-title')]
      .find((item) => item.textContent?.includes('搭載モジュール'));
    title?.click();
  })()`);
  await waitFor(
    `[...document.querySelectorAll('.property-window .prop-window-related-item')]
      .some((item) => getComputedStyle(item).display !== 'none' && item.textContent?.includes('dock-standard'))`,
    'the base dock module to appear in the property window',
  );
  await devTools.evaluate(`(() => {
    const row = [...document.querySelectorAll('.property-window .prop-window-related-item')]
      .find((item) => item.textContent?.includes('dock-standard'));
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
  })()`);
  await waitFor(
    `[...document.querySelectorAll('.property-window .prop-window-item')]
      .some((item) => item.textContent?.includes('船体を建造'))`,
    'the dock construction action to appear',
  );
  await devTools.evaluate(`(() => {
    [...document.querySelectorAll('.property-window .prop-window-item')]
      .find((item) => item.textContent?.includes('船体を建造'))?.click();
  })()`);
  await waitFor(
    `Boolean(document.querySelector('.hud-combat-root.active'))
      && !document.getElementById('ship-construction-panel')?.classList.contains('hidden')`,
    'construction mode to enter the combat view',
  );
  await checkConstructionLayout();

  await devTools.evaluate(`(() => {
    window.__smokeConfirmMessages = [];
    window.confirm = (message) => { window.__smokeConfirmMessages.push(String(message)); return true; };
  })()`);
  await selectConstructionModuleAndPlace('主燃料タンク 3m', 1);
  const materialWarning = await devTools.evaluate(`({
    material: document.querySelector('[data-id="construction-role"]')?.textContent === '物資',
    warned: document.querySelector('[data-id="construction-warning"]')?.textContent?.includes('操縦不能') === true,
  })`);
  expectAll('Cockpit-less construction did not show its material warning', materialWarning);
  await selectConstructionModuleAndPlace('主推進器', 2);
  await selectConstructionModuleAndPlace('ドッキングポート', 3);
  await devTools.evaluate(`(() => {
    const panel = document.getElementById('ship-construction-panel');
    [...panel.querySelectorAll('.construction-actions .w-btn')]
      .find((item) => item.textContent?.trim() === '建造終了')?.click();
  })()`);
  await waitFor(
    `document.getElementById('ship-construction-panel')?.classList.contains('hidden') === true`,
    'the material vessel to launch',
  );
  const confirmed = await devTools.evaluate(
    `window.__smokeConfirmMessages.some((message) => message.includes('操縦不能な物資'))`,
  );
  if (!confirmed) throw new Error('The cockpit-less launch confirmation was not shown.');
}

async function bootAndCheckReady() {
  let state;
  for (let attempt = 0; attempt < 300; attempt++) {
    state = await devTools.evaluate(`({
      ready: document.documentElement.dataset.gameReady === 'true',
      fatal: Boolean(document.getElementById('fatal-error-overlay')),
      fatalText: document.getElementById('fatal-error-overlay')?.textContent ?? '',
    })`);
    if (state.fatal) throw new Error(`Fatal error overlay appeared during browser smoke test: ${state.fatalText}`);
    if (state.ready) break;
    await sleep(100);
  }
  if (!state?.ready) throw new Error('Game did not complete 60 animation frames within 30 seconds.');
  throwIfFatal('Browser reported page exception(s) or console error(s) during boot');
}

try {
  session = await openChromeSession({
    serveDir: path.join(root, 'docs'),
    port,
    debugPort,
    profilePrefix: 'tepui-smoke-',
    extraLaunchArgs: layoutOnly ? [
      '--use-webgpu-adapter=swiftshader',
      '--enable-features=Vulkan',
      '--use-gpu-in-tests',
      '--enable-accelerated-2d-canvas',
      '--disable-dawn-features=disallow_unsafe_apis',
      '--enable-webgpu-developer-features',
    ] : [],
    onEvent: (event) => {
      if (isIgnorableLayoutGpuEvent(event)) return;
      if (event.method === 'Runtime.exceptionThrown') fatalEvents.push(event);
      if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') fatalEvents.push(event);
      if (event.method === 'Inspector.targetCrashed') fatalEvents.push(event);
    },
  });
  devTools = session.devTools;
  if (emulateTouch) await devTools.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const pageQuery = layoutOnly
    ? `${query}${query.includes('?') ? '&' : '?'}layout-smoke=1`
    : query;
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/${pageQuery}` });
  await bootAndCheckReady();
  if (emulateTouch) await revealTouchPad();

  if (!expectCreative) {
    // 戦闘ビューの外観: マップ用の装飾(レールのトグル・PREDICT バー)は出ていない。
    // ステージ状態パネルの有無は見ない — hudSubStatus() を返すステージだけが出す物で、
    // 戦闘ビューの性質ではない(SMOKE_QUERY はどのステージも指せる)。
    const chromeState = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      return {
        combatView: Boolean(document.querySelector('.hud-combat-root.active')),
        combatRootShown: visible(document.querySelector('.hud-combat-root.active')),
        railTogglesHidden: [...document.querySelectorAll('.hud-map-root .rail-toggle')].every((el) => !visible(el)),
        predictHidden: !visible(document.getElementById('hud-predict')),
      };
    })()`);
    expectAll('Combat chrome did not match the combat view', chromeState);
    await checkCombatLayout();
    await checkHelpModal();
    await checkPauseMenu();
  } else {
    // 艦を1隻も置いていないクリエイティブは、マップビューのまま戦闘用パネルを出さない。
    // 配置パネルは右クリックから開く物なので、この時点では閉じている。
    // レールの初期折りたたみは compact 幅かどうかで決まり、ここではまだ表示領域を
    // 明示していないので、畳まれている場合だけ開いてから判定する(無条件にクリックすると
    // 逆に畳んでしまい、開いている前提の判定を壊す)。
    await devTools.evaluate(`(() => {
      for (const side of ['left', 'right']) {
        const rail = document.querySelector('.hud-map-root.active .hud-rail-' + side);
        if (rail?.classList.contains('collapsed')) {
          document.querySelector('.hud-map-root.active .rail-toggle-' + side)?.click();
        }
      }
    })()`);
    const chromeState = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      return {
        mapView: Boolean(document.querySelector('.hud-map-root.active')),
        viewOptionsShown: visible(document.getElementById('hud-view-options')),
        frameControlsShown: [...document.querySelectorAll('.hud-map-root.active .hud-frame-controls')].some(visible),
        objectListShown: visible(document.getElementById('hud-physical-object-list')),
        predictShown: visible(document.getElementById('hud-predict')),
        statusHidden: !visible(document.getElementById('hud-status')),
        placerClosed: !visible(document.getElementById('hud-object-placer')),
      };
    })()`);
    expectAll('Creative mode did not remain in its zero-ship map state', chromeState);
    await checkMapLayout();
    await placeShipThroughMenu();

    // 戦闘ビューへ入れるのは操作できる艦がある時だけなので、[M] が通ること自体が配置の成立を示す。
    // レールの折りたたみはビューの持ち物ではないため、往復しても保たれる。
    await devTools.evaluate(`document.querySelector('.hud-map-root.active .rail-toggle').click()`);
    const collapsedLeft = await devTools.evaluate(`document.querySelector('.hud-map-root.active .hud-rail-left').classList.contains('collapsed')`);
    if (!collapsedLeft) throw new Error('Could not collapse the left rail before the map round trip.');
    await pressKey('m', 'KeyM', 77);
    await waitFor(
      `Boolean(document.querySelector('.hud-combat-root.active'))`,
      '[M] to leave the map (a placed ship must be operable for combat view to be enterable)',
    );
    const combat = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      return {
      railTogglesHidden: [...document.querySelectorAll('.hud-map-root .rail-toggle')].every((el) => !visible(el)),
      };
    })()`);
    expectAll('Combat view still shows the map rail toggles', combat);
    await pressKey('m', 'KeyM', 77);
    await waitFor(`Boolean(document.querySelector('.hud-map-root.active'))`, '[M] to return to the map');
    const backToMap = await devTools.evaluate(`({
      mapView: Boolean(document.querySelector('.hud-map-root.active')),
      collapseKept: document.querySelector('.hud-map-root.active .hud-rail-left').classList.contains('collapsed'),
      toggleGlyphs: JSON.stringify([...document.querySelectorAll('.hud-map-root.active .rail-toggle')].map((el) => el.textContent)) === '["▶","▶"]',
    })`);
    expectAll('Rail collapse state did not survive the map round trip', backToMap);
    await devTools.evaluate(`(() => {
      for (const side of ['left', 'right']) {
        const rail = document.querySelector('.hud-map-root.active .hud-rail-' + side);
        if (!rail?.classList.contains('collapsed')) {
          document.querySelector('.hud-map-root.active .rail-toggle-' + side)?.click();
        }
      }
    })()`);

    // 配置した自艦の一覧行を右クリックするとプロパティウィンドウが開き、画面を狭めても
    // 視界内に留まる。カメラ姿勢次第で天体マーカーがレールの下へ入ることには依存しない。
    await devTools.evaluate(`(() => {
      const rail = document.querySelector('.hud-map-root.active .hud-rail-right');
      if (rail?.classList.contains('collapsed')) {
        document.querySelector('.hud-map-root.active .rail-toggle-right')?.click();
      }
    })()`);
    await waitFor(
      `Boolean(document.querySelector(
        '#hud-physical-object-list-section-player .erow, #hud-physical-object-list-section-base .erow'
      ))`,
      'the placed ship or base to populate the physical object list',
    );
    const shipRowState = await devTools.evaluate(`(() => {
      const row = document.querySelector(
        '#hud-physical-object-list-section-player .erow, #hud-physical-object-list-section-base .erow',
      );
      if (!row || getComputedStyle(row).display === 'none') return { row: null };
      const r = row.getBoundingClientRect();
      return { row: { x: r.left + r.width / 2, y: r.top + r.height / 2, label: row.getAttribute('aria-label') } };
    })()`);
    const shipRow = shipRowState.row;
    if (!shipRow) {
      throw new Error('The placed ship or base row was hidden in the physical object list.');
    }
    await devTools.evaluate(`(() => {
      const row = document.querySelector(
        '#hud-physical-object-list-section-player .erow, #hud-physical-object-list-section-base .erow',
      );
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
    })()`);
    await waitFor(
      `[...document.querySelectorAll('.property-window')].some((el) => getComputedStyle(el).display !== 'none')`,
      `right-clicking ship row ${shipRow.label} to open a property window`,
    );
    await devTools.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
    await sleep(150);
    const clamped = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const win = [...document.querySelectorAll('.property-window')].find(visible);
      if (!win) return { open: false };
      return { open: true, inside: insideViewport(rect(win)) };
    })()`);
    expectAll('Property window did not remain clamped after resize', clamped);
    await clearViewport();
    if (smokeConstruction) await constructMaterialFromBaseDock();
  }

  if (expectCreative && process.env.SMOKE_CREATIVE_PLACE === '2') {
    await placeShipThroughMenu();
    const after = await devTools.evaluate(
      `({ fatal: Boolean(document.getElementById('fatal-error-overlay')), text: document.getElementById('fatal-error-overlay')?.textContent ?? '' })`,
    );
    if (after.fatal) throw new Error(`Creative second placement failed: ${after.text}`);
    throwIfFatal('Creative second placement reported page exception(s)');
  }
  throwIfFatal('Browser reported page exception(s) or console error(s) during interaction');
  const mode = expectCreative ? `creative ${creativePreset} placement` : query;
  console.log(`Browser smoke passed (${mode}): production build ran and its HUD held together without page/console fatal errors.`);
} finally {
  await session?.close();
}
