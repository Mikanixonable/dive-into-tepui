// モバイル相当条件の計測プローブ。本番ビルド docs/ を、モバイル相当のエミュレーション
// (390×844・DPR・mobile・タッチ・iPhone UA・CPU 減速)を掛けたヘッドレス Chrome で開き、
// (a) タイトル画面までとステージ開始までの転送量・所要時間、(b) 戦闘ビューの
// フレーム時間、(c) 画像テクスチャの GPU 常駐推算、(d) 描画経路を、条件ごとの
// Markdown 表として標準出力へ出す。ゲーム本体(src/)は変更しない。
//
// 使い方:
//   node tools/mobile-probe.mjs               # 全条件を測る
//   PROBE_CPU=1 node tools/mobile-probe.mjs   # CPU 減速率を変える(既定 4)
//   PROBE_DPR=1 node tools/mobile-probe.mjs   # DPR を変える(既定 3)
//
// 計測条件ごとに新しい Chrome プロファイルで回し、プリセット条件はページのスクリプトより
// 先に localStorage へ描画設定を書いて選ぶ。
//
// 「タイトル」は ?title=1 で出るステージ選択画面(#stage-select)、「ステージ開始」は
// ?stage=00 の戦闘ビュー(.hud-combat-root.active が出る時点、browser-smoke の待ち条件)。
// 2つの別ナビゲーションで測る。HTTP キャッシュは無効にして、どちらも冷態で全資源を
// 取ったときの転送量を数える(キャッシュ命中の転送は encodedDataLength に載らず、
// ステージ側の合計を過小に読むため)。
import path from 'node:path';
import { openChromeSession, sleep } from './chrome-session.mjs';

const root = path.resolve(import.meta.dirname, '..');
const docsDir = path.join(root, 'docs');
const port = 8780;
const debugPort = 9460;

// モバイル相当の条件。iPhone 14/15 系の論理解像度と Safari の UA。
const VIEWPORT = { width: 390, height: 844 };
const CPU_THROTTLE_RATE = Number(process.env.PROBE_CPU ?? '4');
const DEVICE_SCALE_FACTOR = Number(process.env.PROBE_DPR ?? '3');
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15'
  + ' (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// (a) 転送量を区切る待ち条件。タイトルは stage-select.ts の画面ルート、
// ステージ開始は browser-smoke と同じ戦闘ビューの HUD。
const TITLE_FOUND = `document.getElementById('stage-select') !== null`;
const STAGE_FOUND = `document.querySelector('.hud-combat-root.active') !== null`;
const NAV_TIMEOUT_MS = 180_000;

// (b) 戦闘ビューが出てから置く秒数と、rAF 間隔を集める秒数。
const SETTLE_MS = 5_000;
const FRAME_SAMPLE_MS = 10_000;

// ---- src/render/graphics-settings.ts の GRAPHICS_OPTIONS.presets(→ QUALITY_PRESETS)の写し ----
// Node から src の TS は import できないので値を複製する(perf-probe.mjs と同じ手)。
// 行は [設定キー, low, medium, high]。保存値は全項目を JSON.stringify したものを
// localStorage 'tepui.settings.graphics'(src/settings/user-settings.ts)へ書くだけで、
// formatGraphics と同じ形になる。ズレたときは graphics-settings.ts の各 presets と照合する。
const PRESET_ROWS = [
  ['resolutionScale', 0.5, 0.75, 1],
  ['lodBias', 0.5, 1, 2],
  ['exposureCompensation', 1, 1, 1],
  ['hitShake', true, true, true],
  ['filmLut', 'none', 'none', 'none'],
  ['antialias', 0, 1, 2],
  ['pointField', false, true, true],
  ['rings', false, true, true],
  ['aurora', false, false, true],
  ['atmosphere', 1, 2, 3],
  ['airglow', true, true, true],
  ['clouds', false, true, true],
  ['cloudFieldSource', 'observed', 'generated', 'generated'],
  ['cumulus', true, true, true],
  ['cirrus', true, true, true],
  ['cumulusDetail', 1, 2, 2],
  ['cirrusDetail', 0, 1, 1],
  ['lens', false, true, true],
  ['thrustPlume', 'simple', 'volume', 'volume'],
  ['sunLightModel', 0, 1, 1],
  ['planetLightModel', 0, 0, 1],
  ['planetLightCount', 0, 2, 2],
  ['ambient', true, true, true],
  ['nightObservation', false, false, false],
  ['constructionWorkLight', true, true, true],
  ['meshShadow', false, true, true],
  ['cloudShadow', false, true, true],
  ['shadowSlotCount', 2, 4, 4],
  ['shadowSlotSize', 512, 1024, 1024],
  ['shadowTexelsPerPixel', 0.5, 1, 1],
];
const GRAPHICS_STORAGE_KEY = 'tepui.settings.graphics';
const PRESETS = Object.fromEntries(
  [['low', 0], ['medium', 1], ['high', 2]].map(([name, index]) => [
    name,
    Object.fromEntries(PRESET_ROWS.map(([key, ...values]) => [key, values[index]])),
  ]),
);

const CONDITIONS = [
  { label: '保存なし(初回既定)', preset: null },
  { label: 'プリセット 低', preset: 'low' },
  { label: 'プリセット 中', preset: 'medium' },
  { label: 'プリセット 高', preset: 'high' },
];

function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)];
}

// url へ遷移し、foundExpression が真の DOM になるまで待つ。その時点で finished に届いている
// 転送の合計 [bytes] と、ナビゲーションからの所要時間 [ms]、区間の資源一覧を返す。
// 待ちの間はナビゲーションで実行コンテキストが入れ替わるので、評価の失敗は「まだ出ていない」
// として扱う。fatal-error-overlay が出たらその文言で投げる。
async function navigateUntil(devTools, url, foundExpression, finished, label) {
  const from = finished.length;
  const start = Date.now();
  await devTools.send('Page.navigate', { url });
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  for (;;) {
    let state = null;
    try {
      state = await devTools.evaluate(`({
        found: Boolean(${foundExpression}),
        fatal: document.getElementById('fatal-error-overlay')?.textContent ?? '',
      })`);
    } catch {
      // 遷移中で評価できない。次のポーリングを待つ。
    }
    if (state?.fatal) throw new Error(`${label}: fatal-error-overlay: ${state.fatal}`);
    if (state?.found) break;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(200);
  }
  const segment = finished.slice(from);
  return {
    bytes: segment.reduce((sum, entry) => sum + entry.bytes, 0),
    elapsedMs: Date.now() - start,
    segment,
  };
}

// 区間の転送量の上位 n 件。名前は URL のパス末尾。
function topResources(segment, n = 10) {
  return [...segment].sort((a, b) => b.bytes - a.bytes).slice(0, n).map((entry) => {
    let name;
    try {
      name = decodeURIComponent(new URL(entry.url).pathname) || entry.url;
    } catch {
      name = entry.url;
    }
    if (name.length > 56) name = `…${name.slice(-55)}`;
    return { name, bytes: entry.bytes };
  });
}

async function runCondition(cond) {
  const row = { label: cond.label, notes: [] };
  const requestUrls = new Map();
  // loadingFinished が届いた順の転送。ナビゲーションを跨いで積み、区切りは slice で取る。
  const finished = [];
  const fatalTexts = [];
  const onEvent = (event) => {
    const { method, params } = event;
    if (method === 'Network.requestWillBeSent') {
      requestUrls.set(params.requestId, params.request.url);
    } else if (method === 'Network.loadingFinished') {
      finished.push({ url: requestUrls.get(params.requestId) ?? '(unknown)', bytes: params.encodedDataLength ?? 0 });
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails;
      if (fatalTexts.length < 5) fatalTexts.push(details.exception?.description ?? details.text);
    } else if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
      if (fatalTexts.length < 5) fatalTexts.push(params.args.map((arg) => arg.description ?? String(arg.value)).join(' '));
    } else if (method === 'Inspector.targetCrashed') {
      if (fatalTexts.length < 5) fatalTexts.push('renderer target crashed');
    }
  };

  let session;
  try {
    session = await openChromeSession({
      serveDir: docsDir,
      port,
      debugPort,
      profilePrefix: 'tepui-mobile-probe-',
      windowSize: VIEWPORT,
      emulation: {
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        mobile: true,
        userAgent: MOBILE_UA,
        cpuThrottlingRate: CPU_THROTTLE_RATE,
        touch: true,
      },
      // (c) のテクスチャ読み直しは CPU 減速下で伸びるので、既定の 60 秒より長く取る。
      requestTimeoutMs: 300_000,
      onEvent,
    });
    const { devTools } = session;
    await devTools.send('Network.enable');
    await devTools.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (cond.preset !== null) {
      // ページのスクリプト(UserSettings の読み込み)より先に描画設定を置く。
      // どのナビゲーションでも効くよう、新しい文書ごとに走る式として登録する。
      const saved = JSON.stringify(PRESETS[cond.preset]);
      await devTools.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem(${JSON.stringify(GRAPHICS_STORAGE_KEY)}, ${JSON.stringify(saved)}); } catch {}`,
      });
    }

    // (a) タイトル画面(ステージ選択)までの転送量と所要時間。
    try {
      row.title = await navigateUntil(
        devTools, `${session.baseUrl}/?title=1`, TITLE_FOUND, finished, 'title screen',
      );
    } catch (e) {
      row.notes.push(`タイトル: ${e.message}`);
    }

    // (a) ステージ開始(戦闘ビューの HUD)までの転送量と所要時間。計測の終わりまでの合計も
    // 同じ起点から数える — HUD が出た後に届く天体の画像などを取りこぼさないため。
    const stageFrom = finished.length;
    try {
      row.stageStart = await navigateUntil(
        devTools, `${session.baseUrl}/?stage=00`, STAGE_FOUND, finished, 'combat HUD',
      );
      // WebGL2 フォールバックの通知はランの HUD が動き始めてから約 10 秒出る。
      // 見える間に控える。
      row.hintAtStart = await devTools.evaluate(
        `document.getElementById('hud-hint')?.textContent ?? ''`,
      ).catch(() => '');
    } catch (e) {
      row.notes.push(`ステージ開始: ${e.message}`);
    }

    // (b) 戦闘ビューのフレーム時間。5 秒置いてから rAF 間隔を 10 秒集め、平均と p95。
    try {
      await sleep(SETTLE_MS);
      const deltas = await devTools.evaluate(`(async () => {
        const deltas = [];
        let last = -1;
        let done = false;
        await new Promise((resolve) => {
          const tick = (t) => {
            if (done) return;
            if (last >= 0) deltas.push(t - last);
            last = t;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          setTimeout(() => { done = true; resolve(); }, ${FRAME_SAMPLE_MS});
        });
        return deltas;
      })()`);
      // 間隔は長い停止と短い間隔の二峰になりうるので、中央値ではなく平均(合計 ÷ 個数)で読む。
      const total = deltas.reduce((sum, d) => sum + d, 0);
      row.frame = {
        mean: deltas.length > 0 ? total / deltas.length : null,
        p95: percentile(deltas, 0.95), count: deltas.length,
      };
    } catch (e) {
      row.notes.push(`フレーム: ${e.message}`);
    }

    // (c) 画像テクスチャの GPU 常駐推算。読まれた画像を Image で読み直し、
    // naturalWidth×naturalHeight×4×4/3(mip 込み RGBA8)を足す。
    try {
      const dims = await devTools.evaluate(`(async () => {
        const urls = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name))]
          .filter((name) => /\\.(png|jpe?g|webp)(\\?|$)/i.test(name));
        const dims = [];
        let next = 0;
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (next < urls.length) {
            const url = urls[next++];
            const dim = await new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
              img.onerror = () => resolve(null);
              img.src = url;
            });
            if (dim !== null) dims.push(dim);
          }
        }));
        return dims;
      })()`);
      row.texture = {
        count: dims.length,
        bytes: dims.reduce((sum, [w, h]) => sum + w * h * 4 * 4 / 3, 0),
      };
    } catch (e) {
      row.notes.push(`テクスチャ: ${e.message}`);
    }

    // (d) navigator.gpu の有無と、WebGL2 フォールバックの通知が出たかから描画経路を推す。
    try {
      const gpu = await devTools.evaluate(`(async () => ({
        api: 'gpu' in navigator,
        adapter: 'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null,
        hint: document.getElementById('hud-hint')?.textContent ?? '',
      }))()`);
      row.gpuApi = gpu.api;
      const notice = `${row.hintAtStart ?? ''} ${gpu.hint}`;
      row.backend = notice.includes('WebGL2') ? 'WebGL2(通知)' : gpu.api && gpu.adapter ? 'WebGPU' : '不明';
    } catch (e) {
      row.notes.push(`描画経路: ${e.message}`);
    }
    const sessionSegment = finished.slice(stageFrom);
    row.sessionBytes = sessionSegment.reduce((sum, entry) => sum + entry.bytes, 0);
    row.top = topResources(sessionSegment);
  } catch (e) {
    row.notes.push(String(e?.message ?? e));
  } finally {
    await session?.close();
  }
  if (fatalTexts.length > 0) row.notes.push(`ページの失敗: ${fatalTexts.join(' / ')}`);
  return row;
}

function mb(bytes) {
  return bytes === undefined || bytes === null ? '—' : (bytes / 1e6).toFixed(1);
}

async function main() {
  const rows = [];
  for (const cond of CONDITIONS) {
    console.error(`[mobile-probe] condition: ${cond.label}`);
    rows.push(await runCondition(cond));
  }

  console.log(
    `条件: ${VIEWPORT.width}×${VIEWPORT.height} DPR ${DEVICE_SCALE_FACTOR} mobile touch`
    + ` CPU減速×${CPU_THROTTLE_RATE} UA=iPhone Safari(HTTP キャッシュ無効、各条件は新規プロファイル)`,
  );
  console.log('');
  console.log('| 条件 | タイトルまで [MB] | [s] | ステージ開始まで [MB] | [s] | 計測終了まで [MB] | フレーム平均 [ms] | p95 [ms] | テクスチャ [MB] | 描画経路 | 備考 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const notes = [
      ...(row.frame?.count !== undefined ? [`n=${row.frame.count}`] : []),
      ...row.notes,
    ].join('; ');
    console.log(
      `| ${row.label}`
      + ` | ${mb(row.title?.bytes)} | ${row.title ? (row.title.elapsedMs / 1000).toFixed(1) : '—'}`
      + ` | ${mb(row.stageStart?.bytes)} | ${row.stageStart ? (row.stageStart.elapsedMs / 1000).toFixed(1) : '—'}`
      + ` | ${mb(row.sessionBytes)}`
      + ` | ${row.frame?.mean?.toFixed(1) ?? '—'} | ${row.frame?.p95?.toFixed(1) ?? '—'}`
      + ` | ${mb(row.texture?.bytes)} | ${row.backend ?? '—'} | ${notes || '—'} |`,
    );
  }

  for (const row of rows) {
    if (!row.top || row.top.length === 0) continue;
    console.log(`\n### ${row.label} — 転送量 上位 ${row.top.length} 件(ステージ遷移から計測終了まで)`);
    console.log('| 資源 | [MB] |');
    console.log('| --- | --- |');
    for (const entry of row.top) console.log(`| ${entry.name} | ${mb(entry.bytes)} |`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
