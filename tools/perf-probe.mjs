// パフォーマンス再現計測プローブ。tools/chrome-session.mjs でヘッドレス Chrome を上げ、
// 負荷確認ウィンドウ(PerfMeter, `.prop-window` タイトル「負荷」)の全行をワープ段数・
// ビュー・計画ノード有無ごとに読み取って JSON で出す。ゲーム本体(src/)は一切変更しない。
//
// 使い方:
//   node tools/perf-probe.mjs                       # 条件マトリクス一式(既定)
//   PERF_MODE=timeseries node tools/perf-probe.mjs  # 予測破棄イベントの時系列サンプリング
//   PERF_ONLY=map node tools/perf-probe.mjs         # label にこの文字列を含む条件だけ実行(数字境界で区切って一致判定)
//   PERF_OUT=out.json node tools/perf-probe.mjs     # 結果をファイルにも書く(常に stdout にも出す)
//
// 過去のコミットを測るときは、`src/` だけをそのコミットの内容へ戻してビルドし、このプローブ自身は
// 現在の版のまま走らせる(プローブはビルド済みの docs/ を外側から駆動するだけなので、
// 計測側と被計測側を別の版にできる):
//   git restore --source=<commit> --worktree src/ && npm run build && node tools/perf-probe.mjs
//   git restore --worktree src/                                        # 測り終えたら戻す
//
// 環境変数:
//   共通:        CHROME_PATH
//   matrix モード: PERF_SAMPLES(既定10) PERF_INTERVAL_MS(既定500) PERF_SETTLE_MS(既定3000)
//                  PERF_REPEATS(既定3) PERF_ONLY
//   timeseries モード: PERF_TS_STAGE(既定'1') PERF_TS_WARPS(既定'1,64,1024')
//                      PERF_TS_INTERVAL_MS(既定300) PERF_TS_DURATIONS(既定 warp=1のみ60・他30秒)
//
// 既知の限界: PerfMeter が predictDiscarded 等のカウンタ系を積むのは毎フレームだが、DOM へ
// 出るのは 500ms ごとの flush 期間の avg/max なので、本プローブがそれより速く読んでも同じ値を
// 読み直すだけになりうる。時系列サンプリングは 500ms 周期のストロボ的な観測になる。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const staticPort = 8766;

// ---- src/game/const.ts SIM_SPEED_LEVELS / src/game/input/key-mapping.ts の写し -----------------
// (import はできない — ビルド済み docs/ を外側から駆動するだけなので、値をここに複製する。
//  ズレが心配なら `grep SIM_SPEED_LEVELS src/game/const.ts` で照合すること。)
const SIM_SPEED_LEVELS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 131072];
const KEY_WARP_FASTER = { key: '.', code: 'Period', keyCode: 190 };
const KEY_MAP_MODE = { key: 'm', code: 'KeyM', keyCode: 77 };

// ---- ページ操作ヘルパ ------------------------------------------------------------------------
async function pressKey(devTools, binding) {
  await devTools.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: binding.key, code: binding.code, windowsVirtualKeyCode: binding.keyCode,
  });
  await devTools.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: binding.key, code: binding.code, windowsVirtualKeyCode: binding.keyCode,
  });
}

async function leftClickAt(devTools, x, y) {
  await devTools.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await devTools.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await devTools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function wheelAt(devTools, x, y, deltaY) {
  await devTools.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse',
  });
}

// ゲームが localStorage に置くもの(セーブスロット・スナップショット・表示トグル・
// パネルの畳み方)を全部消す。Chrome プロファイルは条件マトリクス全体で使い回すので、
// 消さないと前のラウンドの状態が次の起動へ持ち越される:
//   - オートセーブが書いたスナップショットは、同じステージの次の起動で復帰し、
//     復帰した周回では Stage.init() が走らない。スナップショットに載らない種別
//     (小惑星・破片)は世界から消え、多数個体を測るはずの条件が自機1隻だけになる。
//   - 表示パネルのトグルは永続するので、軌道線を切る条件の後は、以降の条件が
//     切られたままの状態で始まる。
// 条件・ラウンドごとに必ず新規の周回として起動させるため、navigate の直前に呼ぶ。
async function clearSavedState(devTools, origin) {
  await devTools.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' });
}

// 条件式が真になるまでポーリングする。固定 sleep ではなく条件で待つ(rAF ループの都合)。
async function waitForCondition(fn, label, timeoutMs = 8000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await fn()) return;
    await sleep(intervalMs);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

async function bootAndWaitReady(devTools, timeoutMs = 60000) {
  let state;
  const deadline = Date.now() + timeoutMs;
  do {
    state = await devTools.evaluate(`({
      ready: document.documentElement.dataset.gameReady === 'true',
      fatal: Boolean(document.getElementById('fatal-error-overlay')),
      fatalText: document.getElementById('fatal-error-overlay')?.textContent ?? '',
    })`);
    if (state.fatal) throw new Error(`Fatal error overlay during boot: ${state.fatalText}`);
    if (state.ready) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error('Game did not report gameReady within timeout.');
}

// 負荷確認ウィンドウ(タイトル「負荷」)の全行を {key,label,value} で読む。無ければ null。
async function readPerfRows(devTools) {
  return devTools.evaluate(`(() => {
    const wins = [...document.querySelectorAll('.prop-window')];
    const win = wins.find((w) => w.querySelector('.prop-window-title-main')?.textContent === '負荷');
    if (!win) return null;
    return [...win.querySelectorAll('.prop-window-row')].map((r) => ({
      key: r.dataset.key ?? '',
      label: r.querySelector('.prop-window-row-label')?.textContent ?? '',
      value: r.querySelector('.prop-window-row-value')?.textContent ?? '',
    }));
  })()`);
}

async function currentView(devTools) {
  return devTools.evaluate(`(() => {
    if (document.querySelector('.hud-combat-root.active')) return 'combat';
    if (document.querySelector('.hud-map-root.active')) return 'map';
    return 'unknown';
  })()`);
}

async function ensureView(devTools, target) {
  const view = await currentView(devTools);
  if (view === target) return view;
  await pressKey(devTools, KEY_MAP_MODE);
  await waitForCondition(
    async () => (await currentView(devTools)) === target,
    `view to become ${target} (was ${view})`,
    5000,
  );
  return target;
}

async function currentWarp(devTools) {
  const rows = await readPerfRows(devTools);
  const row = rows?.find((r) => r.key === 'warp');
  const m = row?.value.match(/×(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// 新規ロード直後(ワープ×1)を前提に、Period キーを目標段数まで連打してポーリングで確認する。
async function raiseWarpTo(devTools, target) {
  if (target === 1) return;
  const idx = SIM_SPEED_LEVELS.indexOf(target);
  if (idx < 0) throw new Error(`${target} is not a SIM_SPEED_LEVELS entry: ${SIM_SPEED_LEVELS.join(',')}`);
  for (let i = 0; i < idx; i++) {
    await pressKey(devTools, KEY_WARP_FASTER);
    await sleep(25);
  }
  await waitForCondition(async () => (await currentWarp(devTools)) === target, `warp to reach ×${target}`, 10000);
}

// 「オブジェクト一覧」の自艦行(.erow, 見出し「自艦」区画の唯一の行)をダブルクリックし、
// カメラ焦点を自艦へ移す。object-list-panel.ts の row は dblclick で onFocus(id) を呼ぶ実装
// なので、CDP のクリック座標合わせなしに DOM 直操作で済む。
async function focusCameraOnShip(devTools) {
  return devTools.evaluate(`(() => {
    const headers = [...document.querySelectorAll('.object-list-section-header')];
    const header = headers.find((h) => h.textContent.trim().startsWith('自艦'));
    const body = header?.nextElementSibling;
    const row = body?.querySelector('.erow');
    if (!row) return false;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
}

// 自艦マーカー(.mk-self, ▲)の画面座標。無ければ null。
async function shipMarkerScreenPos(devTools) {
  return devTools.evaluate(`(() => {
    const el = document.querySelector('.mk-self');
    if (!el || getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

// マップ・編集モードで計画軌道折れ線をクリックしてノードを1個置く。
// 計画にノードが0個の間、唯一の区間は自機の予測列そのものなので、その先頭サンプルは
// 自機マーカーの位置とほぼ一致する — 折れ線を画素から目視で探さなくても、マーカー位置
// そのものとその近傍を試打鍵すれば当たる。実際に画面キャプチャで検証済み(色走査では
// クリック対象の線は自機軌道の白線とほぼ重なって見分けが付かなかったが、マーカー近傍への
// クリックは NODE_PICK_PX=30px の許容内に収まり、確実にノードが置けた)。
// 成否は .gz-node(node-gizmo.ts の各ノードハンドル)の増加で確認する。
// 軌道予測パネルの未来側の表示期間ピル(1周/1日/7日/28日)を押す。過去側の行(.predict-past)は
// 同じラベルを持つので除いて探す。押せたら true。
async function selectDisplayDuration(devTools, pillLabel) {
  const rect = await devTools.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.predict-row1')].filter((r) => !r.classList.contains('predict-past'));
    for (const row of rows) {
      for (const b of row.querySelectorAll('.predict-pills .w-btn')) {
        if (b.textContent === ${JSON.stringify(pillLabel)}) {
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  })()`);
  if (!rect) return false;
  await leftClickAt(devTools, rect.x, rect.y);
  await sleep(300);
  return true;
}

async function attemptPlaceNode(devTools) {
  const focused = await focusCameraOnShip(devTools);
  await sleep(700);

  const offsets = [
    [0, 0], [10, 0], [-10, 0], [0, 10], [0, -10],
    [20, 15], [-20, 15], [20, -15], [-20, -15],
    [35, 0], [-35, 0], [0, 35], [0, -35],
    [50, 25], [-50, 25], [50, -25], [-50, -25],
  ];
  const attempts = [];
  for (const zoomTicks of [4, 0, 8, 12]) {
    if (zoomTicks > 0) {
      const pos = (await shipMarkerScreenPos(devTools)) ?? { x: await devTools.evaluate('innerWidth/2'), y: await devTools.evaluate('innerHeight/2') };
      for (let i = 0; i < zoomTicks; i++) {
        await wheelAt(devTools, pos.x, pos.y, -160);
        await sleep(15);
      }
      await sleep(400);
    }
    const pos = await shipMarkerScreenPos(devTools);
    if (!pos) {
      attempts.push({ zoomTicks, ok: false, reason: 'no .mk-self marker on screen' });
      continue;
    }
    for (const [dx, dy] of offsets) {
      const x = pos.x + dx;
      const y = pos.y + dy;
      const before = await devTools.evaluate(`document.querySelectorAll('.gz-node').length`);
      await leftClickAt(devTools, x, y);
      await sleep(250);
      const after = await devTools.evaluate(`document.querySelectorAll('.gz-node').length`);
      if (after > before) {
        return { placed: true, x, y, zoomTicks, focused, attempts };
      }
    }
    attempts.push({ zoomTicks, ok: true, markerPos: pos, offsetsTried: offsets.length });
  }
  return { placed: false, focused, attempts };
}

// ---- 行の値文字列 → 数値の抽出 -----------------------------------------------------------------
// perf-meter.ts の書式(barText / countRow / warp / hit-miss / 素の数値)を素直にパースする。
function parseRowValue(raw) {
  const bar = raw.match(/(-?\d+\.?\d*)ms(?:\s+p95\s+(-?\d+\.?\d*))?(?:\s+max\s+(-?\d+\.?\d*))?/);
  if (bar) {
    return {
      kind: 'ms', avg: parseFloat(bar[1]),
      p95: bar[2] !== undefined ? parseFloat(bar[2]) : null,
      max: bar[3] !== undefined ? parseFloat(bar[3]) : null,
    };
  }
  const avgMax = raw.match(/^avg\s+(-?\d+\.?\d*)\s+max\s+(-?\d+\.?\d*)$/);
  if (avgMax) return { kind: 'avgmax', avg: parseFloat(avgMax[1]), max: parseFloat(avgMax[2]) };
  const warp = raw.match(/^×(\d+)$/);
  if (warp) return { kind: 'warp', avg: parseInt(warp[1], 10) };
  const hitMiss = raw.match(/^hit\s+(-?\d+)\s*\/\s*miss\s+(-?\d+)$/);
  if (hitMiss) return { kind: 'hitmiss', hit: parseInt(hitMiss[1], 10), miss: parseInt(hitMiss[2], 10) };
  if (/^-?\d+\.?\d*$/.test(raw)) return { kind: 'number', avg: parseFloat(raw) };
  return { kind: 'raw' };
}

function median(nums) {
  const xs = nums.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// ============================================================================================
// 条件マトリクスモード: 起動 → ワープ/ビュー/ノードを整えて設定(settle)→ N サンプル取得 → 中央値化。
// これを1条件につき PERF_REPEATS 回(既定3)繰り返し、ラウンド間の中央値を採る。
// ============================================================================================
// 表示パネルの1ボタンを循環させ、指定した天体クラス行の表示状態を合わせる。
// 軌道線を切る計測条件ではラベルを残すため、desiredOn=true は「ラベル＋軌道」、
// false は「ラベル」に合わせる。
async function setOrbitLineFor(devTools, rowLabel, desiredOn) {
  // 表示パネルは既定で畳まれているので、本文が隠れていれば先に開く。
  await devTools.evaluate(`(() => {
    const body = document.querySelector('#hud-view-options .view-options-body');
    if (body && body.classList.contains('collapsed')) {
      document.querySelector('#hud-view-options-toggle')?.click();
    }
  })()`);
  await sleep(200);
  const probe = await devTools.evaluate(`(() => {
    const panel = document.querySelector('#hud-view-options');
    const row = [...document.querySelectorAll('#hud-view-options .target-class-row')]
      .find((candidate) => candidate.querySelector('.body-class-mode-button')?.textContent === ${JSON.stringify(rowLabel)});
    if (!row) return { err: 'no target row', panelHidden: panel ? panel.className : 'no panel' };
    const button = row.querySelector('.body-class-mode-button');
    if (!button) return { err: 'no mode button' };
    const r = button.getBoundingClientRect();
    if (r.width === 0) return { err: 'mode button has zero width', panelClass: panel ? panel.className : '?' };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, mode: button.dataset.displayMode };
  })()`);
  if (!probe || probe.err) return { ok: false, ...(probe ?? { err: 'evaluate returned null' }) };
  const desiredMode = desiredOn ? 'orbit' : 'label';
  if (probe.mode === desiredMode) return { ok: true, mode: probe.mode, clicked: false };
  for (let i = 0; i < 3 && probe.mode !== desiredMode; i++) {
    await leftClickAt(devTools, probe.x, probe.y);
    await sleep(250);
    probe.mode = await devTools.evaluate(`(() => {
      const row = [...document.querySelectorAll('#hud-view-options .target-class-row')]
        .find((candidate) => candidate.querySelector('.body-class-mode-button')?.textContent === ${JSON.stringify(rowLabel)});
      return row?.querySelector('.body-class-mode-button')?.dataset.displayMode ?? null;
    })()`);
  }
  return { ok: probe.mode === desiredMode, mode: probe.mode, clicked: true };
}

async function runConditionOnce(devTools, baseUrl, cond, fatalEvents) {
  const {
    label, stage, warp = 1, view = 'combat', placeNode = false, duration = null,
    orbitLines = null,
    samples = 10, intervalMs = 500, settleMs = 3000,
  } = cond;
  fatalEvents.length = 0;
  const url = `${baseUrl}/?stage=${encodeURIComponent(stage)}&perf=1`;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await clearSavedState(devTools, baseUrl);
      await devTools.send('Page.navigate', { url });
      await bootAndWaitReady(devTools);
      // ビュー切替・ノード配置は等速(×1)の落ち着いた軌道のうちに行う — マップビュー中は
      // editMode=true で PlanGuide.update が早期 return するため consumeNodesUpTo は走らず
      // (plan-guide.ts)、置いたノードはワープを上げても消費されない。それでも「操作」自体は
      // 軌道が暴れていない自然な状態でやるほうが確実なので、ワープ増速は最後に回す。
      const actualView = await ensureView(devTools, view);
      let durationResult = null;
      if (view === 'map' && duration) {
        durationResult = await selectDisplayDuration(devTools, duration);
        if (!durationResult) throw new Error(`display duration pill "${duration}" not found`);
      }
      let orbitLineResult = null;
      if (view === 'map' && orbitLines) {
        orbitLineResult = {};
        for (const rowLabel of orbitLines.rows) {
          orbitLineResult[rowLabel] = await setOrbitLineFor(devTools, rowLabel, orbitLines.on);
        }
      }
      let nodeResult = null;
      if (view === 'map' && placeNode) {
        nodeResult = await attemptPlaceNode(devTools);
      }
      await raiseWarpTo(devTools, warp);
      await sleep(settleMs);

      const sampleRows = [];
      for (let i = 0; i < samples; i++) {
        const rows = await readPerfRows(devTools);
        sampleRows.push(rows ?? []);
        if (i < samples - 1) await sleep(intervalMs);
      }

      // key ごとに中央値化。
      const byKey = new Map();
      for (const rows of sampleRows) {
        for (const r of rows) {
          if (!byKey.has(r.key)) byKey.set(r.key, { label: r.label, raws: [], parsed: [] });
          const entry = byKey.get(r.key);
          entry.raws.push(r.value);
          entry.parsed.push(parseRowValue(r.value));
        }
      }
      const summary = {};
      for (const [key, entry] of byKey) {
        const avgs = entry.parsed.map((p) => p.avg).filter((v) => v !== undefined);
        const p95s = entry.parsed.map((p) => p.p95).filter((v) => v !== null && v !== undefined);
        const maxs = entry.parsed.map((p) => p.max).filter((v) => v !== null && v !== undefined);
        const hits = entry.parsed.map((p) => p.hit).filter((v) => v !== undefined);
        const misses = entry.parsed.map((p) => p.miss).filter((v) => v !== undefined);
        summary[key] = {
          label: entry.label,
          medianAvg: avgs.length ? median(avgs) : null,
          medianP95: p95s.length ? median(p95s) : null,
          medianMax: maxs.length ? median(maxs) : null,
          medianHit: hits.length ? median(hits) : null,
          medianMiss: misses.length ? median(misses) : null,
          lastRaw: entry.raws.at(-1),
          samples: entry.raws,
        };
      }

      return {
        label, stage, requestedWarp: warp, requestedView: view, actualView,
        placeNode, nodeResult, duration, durationResult, orbitLines, orbitLineResult,
        actualWarpAtSampleStart: parseRowValue(sampleRows[0]?.find((r) => r.key === 'warp')?.value ?? '').avg ?? null,
        samples, intervalMs, settleMs,
        rows: summary,
        fatalEvents: [...fatalEvents],
        attempt,
      };
    } catch (e) {
      lastErr = e;
      console.error(`[perf-probe] condition "${label}" attempt ${attempt + 1} failed: ${e.message}`);
      // 接続が死んだまま再試行しても同じところで失敗するので、張り直してから次を試す。
      try {
        await devTools.reconnect();
      } catch (reconnectError) {
        console.error(`[perf-probe] reconnect failed: ${reconnectError.message}`);
      }
      await sleep(500);
    }
  }
  return { label, stage, requestedWarp: warp, requestedView: view, error: String(lastErr), fatalEvents: [...fatalEvents] };
}

// 同じ行の、ラウンドをまたいだ集計。中央値だけでは「その数字を信じてよいか」が判断できないので、
// 各ラウンドの値と、中央値に対する振れ幅の比(spread)を併記する。
function mergeRepeats(runs) {
  const merged = {};
  const keys = new Set(runs.flatMap((r) => Object.keys(r.rows)));
  for (const key of keys) {
    const entries = runs.map((r) => r.rows[key]).filter(Boolean);
    const stat = (field) => {
      const values = entries.map((e) => e[field]).filter((v) => v !== null && v !== undefined);
      if (values.length === 0) return { value: null, values: [], spread: null };
      const mid = median(values);
      const width = Math.max(...values) - Math.min(...values);
      return { value: mid, values, spread: mid ? width / Math.abs(mid) : null };
    };
    const avg = stat('medianAvg');
    const miss = stat('medianMiss');
    const hit = stat('medianHit');
    merged[key] = {
      label: entries[0].label,
      medianAvg: avg.value, avgRuns: avg.values, avgSpread: avg.spread,
      medianP95: stat('medianP95').value,
      medianMax: stat('medianMax').value,
      medianHit: hit.value, hitRuns: hit.values,
      medianMiss: miss.value, missRuns: miss.values, missSpread: miss.spread,
      lastRaw: entries.at(-1).lastRaw,
    };
  }
  return merged;
}

// 1条件を repeats 回、そのつどページ読み込みからやり直して測り、行ごとにラウンド間の中央値を採る。
// 1回きりの値は同じビルドでも update が2倍近く振れるため、ビルド間の比較には使えない。
// 計測できたラウンドが1つも無ければ、最後の失敗をそのまま返す。
async function runCondition(devTools, baseUrl, cond, fatalEvents, repeats) {
  const runs = [];
  for (let round = 0; round < repeats; round++) {
    console.error(`[perf-probe]   round ${round + 1}/${repeats}`);
    runs.push(await runConditionOnce(devTools, baseUrl, cond, fatalEvents));
  }
  const measured = runs.filter((r) => r.rows);
  if (measured.length === 0) return { ...runs.at(-1), repeats, measuredRounds: 0 };
  return {
    ...measured[0],
    repeats,
    measuredRounds: measured.length,
    attempts: runs.map((r) => r.attempt ?? null),
    rows: mergeRepeats(measured),
    fatalEvents: runs.flatMap((r) => r.fatalEvents ?? []),
  };
}

function defaultMatrix() {
  const common = {
    samples: parseInt(process.env.PERF_SAMPLES ?? '10', 10),
    intervalMs: parseInt(process.env.PERF_INTERVAL_MS ?? '500', 10),
    settleMs: parseInt(process.env.PERF_SETTLE_MS ?? '3000', 10),
  };
  return [
    // (a) ワープ倍率を変えたときの推移。stage 1、戦闘ビュー。
    { label: 'stage1-combat-warp1', stage: '1', warp: 1, view: 'combat', ...common },
    { label: 'stage1-combat-warp64', stage: '1', warp: 64, view: 'combat', ...common },
    { label: 'stage1-combat-warp1024', stage: '1', warp: 1024, view: 'combat', ...common },
    { label: 'stage1-combat-warp16384', stage: '1', warp: 16384, view: 'combat', ...common },
    { label: 'stage1-combat-warp65536', stage: '1', warp: 65536, view: 'combat', ...common },

    // (b) ビューの違い。最高ワープで戦闘 vs マップ(ノード0個)。
    { label: 'stage1-map-warp65536-node0', stage: '1', warp: 65536, view: 'map', placeNode: false, ...common },

    // (c) 「計画」の条件依存: ノード1個 / ノード0個 は上と対で、×1 でも対照を取る。
    { label: 'stage1-map-warp1-node0', stage: '1', warp: 1, view: 'map', placeNode: false, ...common },
    { label: 'stage1-map-warp65536-node1', stage: '1', warp: 65536, view: 'map', placeNode: true, ...common },
    { label: 'stage1-map-warp1-node1', stage: '1', warp: 1, view: 'map', placeNode: true, ...common },

    // 操作対象艦がいない状態(CREATIVE, 艦0隻)。
    { label: 'creative-map-warp65536-noship', stage: 'creative', warp: 65536, view: 'map', placeNode: false, ...common },
    { label: 'creative-map-warp1-noship', stage: 'creative', warp: 1, view: 'map', placeNode: false, ...common },

    // (d) エンティティ数の多いステージ(debug-load: 小惑星+破片を多数配置)。
    // マップビューは全個体が予測対象になるので、予測の伸長そのものを測れる唯一の条件。
    // 28日プリセットは、刻み幅の horizon/PREDICT_MAX_STEPS 項が効き始める唯一の条件。
    { label: 'debug-load-combat-warp65536', stage: 'debug-load', warp: 65536, view: 'combat', ...common },
    { label: 'debug-load-combat-warp1', stage: 'debug-load', warp: 1, view: 'combat', ...common },
    { label: 'debug-load-map-warp1', stage: 'debug-load', warp: 1, view: 'map', placeNode: false, ...common },
    // 多数の遠方個体を、伸長が毎フレーム必要になるワープで。×65536 は積分だけで 8.7s/frame に
    // なり計測にならないので、フレーム時間が読める段まで落とす。
    { label: 'debug-load-map-warp1024', stage: 'debug-load', warp: 1024, view: 'map', placeNode: false, ...common },
    // 28日プリセットは horizon/PREDICT_MAX_STEPS 項が効き始める唯一の条件。予測列は
    // この長さでは伸び切らず、予算を飽和させたまま推移する。
    { label: 'stage1-map-warp1-dur28d', stage: '1', warp: 1, view: 'map', placeNode: false, duration: '28日', ...common, settleMs: 8000 },

    // (e) 外挿タイルの焼き直し(TrajectoryLine.syncGeometry)。焼き直しは
    // 「|to - 前回の to| >= 予測列の間引き間隔」で起きるので、simDt が間引き間隔を超える
    // ワープ段では毎フレームになる。1回で最大 MAX_EXTRAPOLATED_SAMPLES = 2048 サンプルぶんの
    // ephemeris.stateOf(すべて別時刻 = リングキャッシュ全ミス)+ frameTransformAt を払う。
    // これは update ではなく sync フェーズに乗るので、sync 行を見ること。
    { label: 'stage1-map-warp1024-dur28d', stage: '1', warp: 1024, view: 'map', placeNode: false, duration: '28日', ...common, settleMs: 8000 },
    { label: 'stage1-map-warp65536-dur28d', stage: '1', warp: 65536, view: 'map', placeNode: false, duration: '28日', ...common, settleMs: 8000 },

    // (f) 軌道線トグルの影響。DEFAULT_MAP_DISPLAY_TOGGLES は敵・基地・弾薬・自艦の
    // Orbit をすべて既定 true にしているので、マップビューでは元から描かれている。
    // したがって測るべきは「開いた状態」ではなく既定 vs 切った状態。
    // stage00 は波状攻撃で敵数が増えるので、敵の軌道線が最も効く条件になる。
    { label: 'stage1-map-warp1-orbitoff', stage: '1', warp: 1, view: 'map', placeNode: false, orbitLines: { rows: ['敵', '基地', '弾薬'], on: false }, ...common },
    { label: 'stage00-map-warp1', stage: '00', warp: 1, view: 'map', placeNode: false, ...common, settleMs: 20000 },
    { label: 'stage00-map-warp1-orbitoff', stage: '00', warp: 1, view: 'map', placeNode: false, orbitLines: { rows: ['敵', '基地', '弾薬'], on: false }, ...common, settleMs: 20000 },
  ];
}

// PERF_ONLY はカンマ区切りのトークン列。各トークンは label 中に「数字境界で区切られた形」で
// 現れる場合だけ一致とみなす(例: "warp1" は "…warp1-node0" には一致するが "…warp1024" には
// 一致しない — 末尾が数字で続いてしまう場合を弾く)。
function matchesOnly(label, only) {
  if (!only) return true;
  return only.split(',').some((rawTok) => {
    const tok = rawTok.trim();
    if (!tok) return false;
    const i = label.indexOf(tok);
    if (i < 0) return false;
    const after = label[i + tok.length];
    return after === undefined || !/[0-9]/.test(after);
  });
}

async function runMatrix(devTools, baseUrl) {
  const only = process.env.PERF_ONLY;
  const repeats = Math.max(1, parseInt(process.env.PERF_REPEATS ?? '3', 10));
  const all = defaultMatrix().filter((c) => matchesOnly(c.label, only));
  const fatalEvents = [];
  const results = [];
  for (const cond of all) {
    console.error(`[perf-probe] running condition: ${cond.label}`);
    const result = await runCondition(devTools, baseUrl, cond, fatalEvents, repeats);
    results.push(result);
  }
  return { mode: 'matrix', generatedAt: new Date().toISOString(), repeats, results };
}

// ============================================================================================
// 時系列モード: 予測破棄(predictDiscarded)の sawtooth 再現確認。
// PerfMeter は毎フレーム積むが、DOM へ出るのは 500ms ごとの flush 期間の avg/max で、次の
// flush までその値を保持するだけなので、それより速く読んでも「同じ値をもう一度読むだけ」に
// なりうる。したがって本プローブの時系列も「破棄が起きた真の全イベント」を保証できるものでは
// なく、500ms 周期のストロボ的な観測になる。この限界は正直に報告する。
// ============================================================================================
// 1回の evaluate で4行分まとめて読む(往復を4回に増やさない)。
async function sampleTimeseriesRows(devTools) {
  const rows = await readPerfRows(devTools);
  const get = (key) => {
    const row = rows?.find((r) => r.key === key);
    return row ? (parseRowValue(row.value).avg ?? null) : null;
  };
  return {
    discarded: get('pred-discard'), steps: get('pred-steps'),
    complete: get('pred-complete'), tracked: get('pred-tracked'),
  };
}

async function runTimeseriesForWarp(devTools, baseUrl, { stage, warp, durationSec, intervalMs }, fatalEvents) {
  fatalEvents.length = 0;
  const url = `${baseUrl}/?stage=${encodeURIComponent(stage)}&perf=1`;
  await clearSavedState(devTools, baseUrl);
  await devTools.send('Page.navigate', { url });
  await bootAndWaitReady(devTools);
  await raiseWarpTo(devTools, warp);
  await ensureView(devTools, 'combat');
  await sleep(1000); // 安定するまでの猶予

  const series = [];
  const start = Date.now();
  while (Date.now() - start < durationSec * 1000) {
    const t = (Date.now() - start) / 1000;
    const { discarded, steps, complete, tracked } = await sampleTimeseriesRows(devTools);
    series.push({ t: Number(t.toFixed(2)), discarded, steps, complete, tracked });
    await sleep(intervalMs);
  }

  // 破棄イベント数: discarded>0 の連続した読み取りを1イベントとして畳む(500ms flush の
  // スナップショットをポーリング間隔 < flush 間隔で複数回読んでしまう分の重複を避けるため)。
  let events = 0;
  let inRun = false;
  for (const s of series) {
    if ((s.discarded ?? 0) > 0) {
      if (!inRun) { events++; inRun = true; }
    } else {
      inRun = false;
    }
  }
  const avgIntervalSec = events > 0 ? durationSec / events : null;

  return {
    stage, warp, durationSec, intervalMs,
    events, avgIntervalSec,
    series,
    fatalEvents: [...fatalEvents],
  };
}

async function runTimeseries(devTools, baseUrl) {
  const stage = process.env.PERF_TS_STAGE ?? '1';
  const warps = (process.env.PERF_TS_WARPS ?? '1,64,1024').split(',').map((s) => parseInt(s.trim(), 10));
  const intervalMs = parseInt(process.env.PERF_TS_INTERVAL_MS ?? '300', 10);
  const durationsEnv = process.env.PERF_TS_DURATIONS;
  const durations = durationsEnv
    ? durationsEnv.split(',').map((s) => parseInt(s.trim(), 10))
    : warps.map((w) => (w === 1 ? 60 : 30));
  const fatalEvents = [];
  const results = [];
  for (let i = 0; i < warps.length; i++) {
    const warp = warps[i];
    const durationSec = durations[i] ?? 30;
    console.error(`[perf-probe] timeseries: stage=${stage} warp=${warp} duration=${durationSec}s interval=${intervalMs}ms`);
    const result = await runTimeseriesForWarp(devTools, baseUrl, { stage, warp, durationSec, intervalMs }, fatalEvents);
    results.push(result);
  }
  return { mode: 'timeseries', generatedAt: new Date().toISOString(), results };
}

// ============================================================================================
// main
// ============================================================================================
async function main() {
  const debugPort = 9333;
  const fatalEvents = [];
  let session;
  try {
    session = await openChromeSession({
      serveDir: path.join(root, 'docs'),
      port: staticPort,
      debugPort,
      profilePrefix: 'tepui-perf-',
      windowSize: { width: 1280, height: 800 },
      onEvent: (event) => {
        if (event.method === 'Runtime.exceptionThrown') fatalEvents.push(event);
        if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') fatalEvents.push(event);
        if (event.method === 'Inspector.targetCrashed') fatalEvents.push(event);
      },
    });
    const devTools = session.devTools;
    const baseUrl = session.baseUrl;

    const mode = process.env.PERF_MODE ?? 'matrix';
    const output = mode === 'timeseries'
      ? await runTimeseries(devTools, baseUrl)
      : await runMatrix(devTools, baseUrl);
    output.chromeExceptionsDuringEntireRun = fatalEvents.map((event) => {
      if (event.method === 'Runtime.exceptionThrown') {
        return `exception: ${event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text}`;
      }
      if (event.method === 'Runtime.consoleAPICalled') {
        return `console.error: ${event.params.args.map((arg) => arg.description ?? String(arg.value)).join(' ')}`;
      }
      return `${event.method}: ${JSON.stringify(event.params ?? {})}`;
    });

    const json = JSON.stringify(output, null, 2);
    console.log(json);
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, json);
  } finally {
    await session?.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
