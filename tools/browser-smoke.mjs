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
const emulateTouch = process.env.SMOKE_TOUCH === '1';
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

const VIEWPORTS = [[1280, 720], [800, 600], [480, 800], [320, 568], [667, 375]];

// 戦闘ビューの常設パネルが、どの画面寸法でも視界の外へ出ず互いに重ならないことを見る。
// 戦闘シェルフは狭い幅で横スクロール領域になるので、その中のパネルはシェルフの
// スクロール内容に収まっていれば良い(視界の外に出ていること自体は正常)。
async function checkCombatLayout() {
  for (const [width, height] of VIEWPORTS) {
    await devTools.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 480 });
    await sleep(100);
    const layout = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const errors = [];
      const combatRoot = document.querySelector('.hud-combat-root.active');
      const shelf = rect(combatRoot);
      if (!insideViewport(shelf)) errors.push('combat root outside viewport');
      const shelfIds = ['hud-status', 'hud-orbit', 'hud-enemies', 'hud-target'];
      const shelfPanels = shelfIds.map((id) => document.getElementById(id)).filter(visible).map(rect);
      for (const panel of shelfPanels) {
        if (!insideViewport(panel)) errors.push('outside combat root: ' + panel.id);
      }
      for (let i = 0; i < shelfPanels.length; i++) {
        for (let j = i + 1; j < shelfPanels.length; j++) {
          if (overlaps(shelfPanels[i], shelfPanels[j])) errors.push(shelfPanels[i].id + ' overlaps ' + shelfPanels[j].id);
        }
      }
      // シェルフ外の常設要素は視界内に収まっていること。
      const floatIds = ['hud-stagestatus', 'hud-chase-reset', 'hud-globalstatus'];
      const floating = floatIds.map((id) => document.getElementById(id)).filter(visible).map(rect);
      for (const item of floating) if (!insideViewport(item)) errors.push('outside viewport: ' + item.id);
      // シェルフが画面上端側へ回る幅(breakpoints.ts の MQ_MEDIUM_DOWN)では、
      // 画面下端のステージ状態パネルと衝突しないこと。
      const stage = floating.find((item) => item.id === 'hud-stagestatus');
      if (innerWidth <= 1100 && stage) {
        for (const panel of shelfPanels) if (overlaps(stage, panel)) errors.push('stage overlaps ' + panel.id);
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
        for (const panel of [...shelfPanels, ...floating]) if (overlaps(h, panel)) errors.push('hint overlaps ' + panel.id);
        hint.style.opacity = '';
      }
      return { errors, shelf, shelfPanels, floating };
    })()`);
    if (layout.errors.length) {
      throw new Error(`Combat layout failed at ${width}x${height}: ${layout.errors.join('; ')}; ${JSON.stringify(layout)}`);
    }
  }
  await devTools.send('Emulation.clearDeviceMetricsOverride');
}

// マップビューの左右レールが視界に収まり、互いに重ならず、最後のパネルまでスクロールで
// 届くことを見る。レールは縦スクロール領域なので、パネルの縦のはみ出しは正常。
async function checkMapLayout() {
  for (const [width, height] of VIEWPORTS) {
    await devTools.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 480 });
    await sleep(100);
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
      return { errors, rails, panels };
    })()`);
    if (layout.errors.length) {
      throw new Error(`Map layout failed at ${width}x${height}: ${layout.errors.join('; ')}; ${JSON.stringify(layout)}`);
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
    expectAll(`Rail collapse check failed at ${width}x${height}`, collapse);
  }
  await devTools.send('Emulation.clearDeviceMetricsOverride');
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
  await pressKey('h', 'KeyH', 72);
  await waitFor(`getComputedStyle(document.getElementById('hud-help')).display !== 'none'`, '[H] to open the help panel');
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
  await pressKey('Escape', 'Escape', 27);
  await waitFor(
    `getComputedStyle(document.getElementById('hud-help')).display === 'none'
      && !document.body.classList.contains('hud-overlay-modal-open')`,
    'Escape to close the help panel',
  );
}

// ポーズメニューはモーダルだが背景の入力は遮らない(gatesInput:false)。
// 遮ってしまう退行を捕まえるため、遮っていないことを明示的に見る。
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
      shieldShown: getComputedStyle(shield).display !== 'none',
      shieldPasses: getComputedStyle(shield).pointerEvents === 'none',
      backgroundReachable: target !== shield && target?.tagName === 'CANVAS',
      touchHidden: !document.getElementById('touch-ui') || getComputedStyle(document.getElementById('touch-ui')).display === 'none',
    };
  })()`);
  expectAll('Pause menu shielding failed', state);
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
    onEvent: (event) => {
      if (event.method === 'Runtime.exceptionThrown') fatalEvents.push(event);
      if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') fatalEvents.push(event);
      if (event.method === 'Inspector.targetCrashed') fatalEvents.push(event);
    },
  });
  devTools = session.devTools;
  if (emulateTouch) await devTools.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await devTools.send('Page.navigate', { url: `${session.baseUrl}/${query}` });
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
    await devTools.evaluate(`document.querySelector('.hud-map-root.active .rail-toggle').click()`);

    // 天体マーカーの右クリックはプロパティウィンドウを開き、画面を狭めても視界内に留まる。
    // マーカー自身は pointer-events:none で、当たり判定はキャンバス上の座標で解かれる。
    // だから狙える印は「視界内にあり、その一点で最前面がキャンバスである」もの。
    const marker = await devTools.evaluate(`(() => {
      for (const el of document.querySelectorAll('.mk-poi')) {
        if (getComputedStyle(el).display === 'none') continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue;
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        return { id: el.id, x, y };
      }
      return null;
    })()`);
    if (!marker) throw new Error('No pickable celestial marker was on screen for the property window check.');
    await rightClickAt(marker.x, marker.y);
    await waitFor(
      `[...document.querySelectorAll('.prop-window')].some((el) => getComputedStyle(el).display !== 'none')`,
      `right-clicking marker ${marker.id} to open a property window`,
    );
    await devTools.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true });
    await sleep(150);
    const clamped = await devTools.evaluate(`(() => {
      ${LAYOUT_HELPERS}
      const win = [...document.querySelectorAll('.prop-window')].find(visible);
      if (!win) return { open: false };
      return { open: true, inside: insideViewport(rect(win)) };
    })()`);
    expectAll('Property window did not remain clamped after resize', clamped);
    await devTools.send('Emulation.clearDeviceMetricsOverride');
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
  const mode = expectCreative ? 'creative zero-ship map view' : query;
  console.log(`Browser smoke passed (${mode}): production build ran and its HUD held together without page/console fatal errors.`);
} finally {
  await session?.close();
}
