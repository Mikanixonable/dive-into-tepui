// 雲の実験環境の画面。表示する量を選び、時刻を動かして、天気のモデルの写しを正距円筒で見る。
// 「天気図」は同じ天気のモデルの面を 2D canvas へ焼いて出す(器は synoptic-panel が持つ)。
import { CloudLabCanvas } from './lab';
import type { LabProbe } from './lab';
import { SECONDS_PER_HOUR } from './time-units';
import { CLOUD_LAB_VIEWS, type CloudLabViewId } from './views';
import { createViewLegend } from './view-legend';
import { createSynopticPanel } from './synoptic-panel';
import { buildFramingRow } from './framing-controls';
import { buildTimeControls } from './time-controls';
import type { Framing, SynopticLayers } from './synoptic-map';
import { buildButtonRow, buildCheckbox } from '../lab-controls';
import { labStateQuery, parseLabState } from './url-state';
import type { LabState } from './url-state';
import { CLOUD_TUNING } from '../../src/render/earth-weather/cloud-tuning';
import { buildTuningControls } from './tuning-controls';
import { latestReportText } from './latest-report';
// 実験環境が回す天体の目盛り。lab と同じく地球で解く。
import { R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import { cyclonePlacementsAt } from '../../src/render/earth-weather/cyclone-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/earth-weather/anticyclone-tracks';
import type { PressurePlacement } from '../../src/render/earth-weather/tracks';

// 写す表示。GPU の写し(CLOUD_LAB_VIEWS)に、2D canvas へ焼く天気図モードを足す。
type ViewChoice = CloudLabViewId | 'synoptic';

// 画面のモード。「写し」は GPU の写しを量ごとに選ぶ画面、「天気図」は全球の面を出す画面 —
// 写しのひとつではなくモードなので、写しのボタン列とは別のタブで切り替える。
type Mode = 'cloud' | 'synoptic';
const MODE_LABELS: readonly (readonly [Mode, string])[] = [
  ['cloud', '写し'],
  ['synoptic', '天気図'],
];

// 天気図に重ねる層の並び(チェックボックスの順)。
const LAYER_LABELS: readonly (readonly [keyof SynopticLayers, string])[] = [
  ['fill', '気圧'],
  ['coast', '海岸線'],
  ['isobars', '等圧線'],
  ['streamlines', '上層流線'],
  ['surfaceWind', '地表風'],
  ['wave', '偏西風の蛇行'],
  ['symbols', '前線・中心'],
];

declare global {
  interface Window {
    // 撮影の駆動(tools/cloud-lab-shot.mjs・tools/cloud-lab-compare.mjs)が CDP から読む入口。
    cloudLab?: {
      views: readonly ViewChoice[];
      show: (id: ViewChoice) => void;
      setTime: (hours: number) => void;
      aimCap: (latitude: number, longitude: number, radius: number) => void;
      capture: () => Promise<string>;
      // 時刻 [h] の低気圧の谷と高気圧の丘の配置。撮影の駆動が中心の位置を統計の範囲の
      // 切り分けに使う。
      cyclonesAt: (hours: number) => {
        readonly tropicals: readonly (PressurePlacement | null)[];
        readonly lows: readonly (PressurePlacement | null)[];
        readonly highs: readonly (PressurePlacement | null)[];
      };
      // モデルの調整値。いまの全値を返すものと、渡した値を適用して焼き直すもの — 戻った時点で
      // 焼き直し済みなので、続けて capture すれば新しい値の場が撮れる。
      params: () => Record<string, number>;
      setParams: (next: Record<string, number>) => void;
      // 画面の画素 (xPx, yPx、器の内部解像度)の緯度・経度と、そこに出ている量を読む。
      // ヘッドレスの計測がプローブと同じ経路を使う口。値を持たない点では null。
      probeAt: (xPx: number, yPx: number) => Promise<LabProbe | null>;
      // URL に載せているのと同じ形の状態を返す。ヘッドレスの計測が再現の確認に使う口。
      state: () => LabState;
    };
  }
}

// 器を起こし、操作部品を配線し、撮影の入口を window へ出す。
async function init(): Promise<void> {
  // 撮影の駆動(tools/cloud-lab-*.mjs)は ?capture-only を付けて開く — 画面へ提示しない撮影専用
  // (理由は lab.ts の render())。人が開くときは付けないので、画面はこれまでどおり出る。
  const captureOnly = new URLSearchParams(location.search).has('capture-only');
  // URL に載った状態は起こす前に読む。読んだ値は器が立つ場所へ順に流す。
  const initial = parseLabState(location.search);
  const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
  const canvas = await CloudLabCanvas.create(viewCanvas, captureOnly);
  const mapCanvas = document.getElementById('map') as HTMLCanvasElement;
  const panel = createSynopticPanel(mapCanvas, document.getElementById('status')!);
  // 操作部品が立つ前に入れられる値はここで入れる — 部品の初期値が復元した値を拾うように。
  if (initial.hours !== null) canvas.setTime(initial.hours);
  if (initial.cap !== null) {
    canvas.aimCap(initial.cap.latitude, initial.cap.longitude, initial.cap.radius);
  }
  if (initial.map !== null) panel.setFraming(initial.map);
  if (initial.layers !== null) {
    for (const [key] of LAYER_LABELS) panel.setLayer(key, initial.layers.includes(key));
  }

  let currentView: ViewChoice = canvas.currentView;
  // 写しモードに戻ったときに出す写し。タブの往復でモードだけが切り替わり、写しの選択は保つ。
  let lastCloudView: CloudLabViewId = canvas.currentView;

  // 時刻の変化を GPU の写しか天気図へ流す。天気図のあいだは GPU を焼き直さず、戻るときに追いつかせる。
  const applyTime = (hours: number): void => {
    if (currentView === 'synoptic') panel.refresh(hours);
    else {
      canvas.setTime(hours);
      canvas.render();
    }
    writeStateSoon();
  };
  const time = buildTimeControls('time', canvas.hours, applyTime);

  // 見る範囲。写しの cap は canvas が持ち、天気図の窓は panel が持つ。操作行はいまのモードのものを映す。
  const cloudFraming = (): Framing => ({
    latitude: canvas.capCenterLatitude, longitude: canvas.capCenterLongitude, radius: canvas.capAngularRadius,
  });
  const framingRow = buildFramingRow('cap', 'capTitle', (framing) => {
    if (currentView === 'synoptic') panel.setFraming(framing);
    else {
      canvas.aimCap(framing.latitude, framing.longitude, framing.radius);
      canvas.render();
    }
    writeStateSoon();
  });
  const syncFraming = (): void => {
    const synoptic = currentView === 'synoptic';
    framingRow.show(synoptic ? panel.framing : cloudFraming(), synoptic ? '地図の窓' : 'cap', synoptic);
  };

  // いまの画面の状態 → URL。変化のたびに少し待って 1 回だけ書く — 時刻のつまみや窓の
  // 入力は連打されるので、その度に history へ書くと更新が飽和する。知らないキー
  // (capture-only など)は labStateQuery が保持する。
  const currentState = (): LabState => ({
    mode: currentView === 'synoptic' ? 'synoptic' : 'cloud',
    view: currentView === 'synoptic' ? null : currentView,
    hours: time.hours,
    cap: cloudFraming(),
    map: panel.framing,
    layers: LAYER_LABELS.filter(([key]) => panel.layers[key]).map(([key]) => key),
  });
  let stateTimer = 0;
  const writeState = (): void => {
    const query = labStateQuery(currentState(), location.search);
    const url = `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`;
    history.replaceState(null, '', url);
  };
  const writeStateSoon = (): void => {
    window.clearTimeout(stateTimer);
    stateTimer = window.setTimeout(writeState, 300);
  };

  const layersRow = document.getElementById('layers')!;
  for (const [key, label] of LAYER_LABELS) {
    buildCheckbox('layers', label, panel.layers[key], (on) => {
      panel.setLayer(key, on);
      writeStateSoon();
    });
  }

  // ホバー位置の読み。チェックは両モードで見える範囲の行へ置き、出すのはカーソル追従の #tip。
  // 写し側は画素の読み戻しが要るので同時に 1 回だけ走らせ、天気図側は読み戻した面を拾うだけ。
  const tip = document.getElementById('tip')!;
  let probeOn = false;
  let probeQueued = false;
  let probeEvent: { canvas: HTMLCanvasElement; x: number; y: number; cx: number; cy: number } | null = null;
  const runProbe = async (): Promise<void> => {
    probeQueued = false;
    const event = probeEvent;
    if (event === null || !probeOn) return;
    const rect = event.canvas.getBoundingClientRect();
    const xPx = Math.floor(event.x * event.canvas.width / rect.width);
    const yPx = Math.floor(event.y * event.canvas.height / rect.height);
    const probe = currentView === 'synoptic'
      ? panel.probeAt(xPx, yPx) : await canvas.probeAt(xPx, yPx);
    if (probe === null) { tip.hidden = true; return; }
    const lat = `${Math.abs(probe.latitude).toFixed(1)}°${probe.latitude >= 0 ? 'N' : 'S'}`;
    const lon = `${Math.abs(probe.longitude).toFixed(1)}°${probe.longitude >= 0 ? 'E' : 'W'}`;
    tip.textContent = `${lat} ${lon}\n${probe.text}`;
    tip.style.left = `${event.cx + 12}px`;
    tip.style.top = `${event.cy + 12}px`;
    tip.hidden = false;
  };
  for (const el of [viewCanvas, mapCanvas]) {
    el.addEventListener('mousemove', (e) => {
      if (!probeOn) return;
      probeEvent = { canvas: el, x: e.offsetX, y: e.offsetY, cx: e.clientX, cy: e.clientY };
      if (!probeQueued) {
        probeQueued = true;
        void runProbe();
      }
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
  buildCheckbox('cap', 'プローブ', false, (on) => {
    probeOn = on;
    tip.hidden = true;
  });

  const showLegend = createViewLegend(document.getElementById('legend')!);

  // ボタン列は雲種ごと 1 項目に畳んだ列(撮影口は列全体を .views へ出す)。
  const entries: readonly (readonly [CloudLabViewId, string])[] =
    CLOUD_LAB_VIEWS.filter((view) => !view.hidden).map((view) => [view.id, view.label] as const);
  const viewsRow = document.getElementById('views')!;
  const selectView = (id: ViewChoice): void => {
    currentView = id;
    const synoptic = id === 'synoptic';
    markMode(synoptic ? 'synoptic' : 'cloud');
    viewCanvas.style.display = synoptic ? 'none' : '';
    mapCanvas.style.display = synoptic ? '' : 'none';
    // モードごとの操作行だけを出す — 写しの列は写しモード、層のチェックは天気図モード。
    // 見る範囲のつまみは両モードで見せる(天気図では地図の窓になる)。
    viewsRow.style.display = synoptic ? 'none' : '';
    layersRow.style.display = synoptic ? '' : 'none';
    syncFraming();
    if (synoptic) {
      showLegend(null);
      panel.refresh(time.hours);
    } else {
      lastCloudView = id;
      markView(id);
      showLegend(CLOUD_LAB_VIEWS.find((view) => view.id === id)!.legend);
      // 天気図を出しているあいだ GPU 側の時刻は動かしていないので、ここで追いつかせる。
      canvas.setTime(time.hours);
      canvas.show(id);
      canvas.render();
    }
    writeStateSoon();
  };
  const markMode = buildButtonRow<Mode>('mode', MODE_LABELS,
    (mode) => selectView(mode === 'synoptic' ? 'synoptic' : lastCloudView));
  const markView = buildButtonRow<CloudLabViewId>('views', entries, selectView);

  // モデルの調整値(uniform)をいじる束。変更は焼き直し(debounce 済み)へ — 焼き直しは雲場 1 面ぶんの
  // 費用が掛かるので、ドラッグ中は止めず最後の変更から少し待って1回だけ走らせる。
  // 束の正本は tuning-controls — 描画側モード(detail.html)の写しも同じ束を使う。
  const tuning = buildTuningControls(
    document.getElementById('p-panel')!, document.getElementById('p-json')!,
    document.getElementById('error')!,
    () => {
      canvas.invalidate();
      if (currentView !== 'synoptic') canvas.render();
    });
  // immediate(撮影口の setParams 用)は「返った時点で焼き直し済み」にするためのもの —
  // 呼び側がそのまま capture できるようにする。
  const applyParams = (next: Parameters<typeof tuning.applyParams>[0], rebakeNow = false): void =>
    tuning.applyParams(next, rebakeNow);
  applyParams(Object.fromEntries(
    Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value])));

  // 最後に回した比較の評価値。撮影つきの比較(CLI)の結果なので、いま開いているパラメータの
  // 評価ではない — 未実行ならその旨だけ出す。
  const score = document.getElementById('score')!;
  void latestReportText('compare/latest.json').then((text) => {
    score.textContent = text ?? '評価 — (cloud-lab:compare 未実行)';
  });

  // 初回の描画。URL にモード・写しがあれば selectView へ流して復元し、なければ既定の写し。
  if (initial.mode === 'synoptic' || initial.view === 'synoptic') selectView('synoptic');
  else if (initial.view !== null
    && CLOUD_LAB_VIEWS.some((view) => view.id === initial.view)) {
    selectView(initial.view as CloudLabViewId);
  } else {
    markMode('cloud');
    markView(canvas.currentView);
    showLegend(CLOUD_LAB_VIEWS.find((view) => view.id === canvas.currentView)!.legend);
    syncFraming();
    canvas.render();
  }

  window.cloudLab = {
    // 撮影で読める写しは全列(畳んだ写像も含む)。ボタン列に出るのは畳んだあとの列だけ。
    views: [...CLOUD_LAB_VIEWS.map((view) => view.id), 'synoptic'],
    show: selectView,
    setTime: time.setHours,
    aimCap: (latitude, longitude, radius) => {
      canvas.aimCap(latitude, longitude, radius);
      if (currentView !== 'synoptic') canvas.render();
      syncFraming();
      writeStateSoon();
    },
    capture: async () => {
      if (currentView !== 'synoptic') return canvas.capture();
      // 天気図は焼きが残っているかもしれない — 終わるまで待って 2D canvas を拾う。
      await panel.settled();
      return mapCanvas.toDataURL('image/png');
    },
    cyclonesAt: (hours) => ({
      ...cyclonePlacementsAt(hours * SECONDS_PER_HOUR, R_EARTH, SIDEREAL_DAY),
      highs: Array.from({ length: HIGH_COUNT }, (_, index) => highPlacementAt(index, hours * SECONDS_PER_HOUR, R_EARTH)),
    }),
    params: () => Object.fromEntries(Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value])),
    setParams: (next) => applyParams(next, true),
    probeAt: (xPx, yPx) => currentView === 'synoptic'
      ? Promise.resolve(panel.probeAt(xPx, yPx)) : canvas.probeAt(xPx, yPx),
    state: () => currentState(),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
