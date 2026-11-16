// 雲の実験環境の画面。表示する量を選び、時刻を動かして、天気のモデルの写しを正距円筒で見る。
// 「天気図」は同じ天気のモデルの面を 2D canvas へ焼いて出す(器は synoptic-panel が持つ)。
import { CloudLabCanvas } from './lab';
import { SECONDS_PER_HOUR } from './time-units';
import { CLOUD_LAB_VIEWS, type CloudLabViewId } from './views';
import { createViewLegend } from './view-legend';
import { createSynopticPanel } from './synoptic-panel';
import { buildFramingRow } from './framing-controls';
import { buildTimeControls } from './time-controls';
import type { Framing, SynopticLayers } from './synoptic-map';
import { buildButtonRow, buildCheckbox, buildSlider } from '../lab-controls';
import { CLOUD_TUNING, CLOUD_TUNING_DEFAULTS, type CloudTuningId } from '../../src/render/earth-weather/cloud/cloud-tuning';
import { GENERATION_PARAMS, type GenerationParamSpec } from './generation-params';
import { latestReportText } from './latest-report';
// 実験環境が回す天体の目盛り。lab と同じく地球で解く。
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import {
  LOW_COUNT, TROPICAL_COUNT, lowPlacementAt, tropicalPlacementAt,
} from '../../src/render/earth-weather/cyclone-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/earth-weather/anticyclone-tracks';
import type { CyclonePlacement } from '../../src/render/earth-weather/cyclone-tracks';

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
        readonly tropicals: readonly (CyclonePlacement | null)[];
        readonly lows: readonly (CyclonePlacement | null)[];
        readonly highs: readonly (CyclonePlacement | null)[];
      };
      // モデルの調整値。いまの全値を返すものと、渡した値を適用して焼き直すもの — 戻った時点で
      // 焼き直し済みなので、続けて capture すれば新しい値の場が撮れる。
      params: () => Record<string, number>;
      setParams: (next: Record<string, number>) => void;
    };
  }
}

// 器を起こし、操作部品を配線し、撮影の入口を window へ出す。
async function init(): Promise<void> {
  // 撮影の駆動(tools/cloud-lab-*.mjs)は ?capture-only を付けて開く — 画面へ提示しない撮影専用
  // (理由は lab.ts の render())。人が開くときは付けないので、画面はこれまでどおり出る。
  const captureOnly = new URLSearchParams(location.search).has('capture-only');
  const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
  const canvas = await CloudLabCanvas.create(viewCanvas, captureOnly);
  const mapCanvas = document.getElementById('map') as HTMLCanvasElement;
  const panel = createSynopticPanel(mapCanvas, document.getElementById('status')!);

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
  });
  const syncFraming = (): void => {
    const synoptic = currentView === 'synoptic';
    framingRow.show(synoptic ? panel.framing : cloudFraming(), synoptic ? '地図の窓' : 'cap', synoptic);
  };

  const layersRow = document.getElementById('layers')!;
  for (const [key, label] of LAYER_LABELS) {
    buildCheckbox('layers', label, panel.layers[key], (on) => panel.setLayer(key, on));
  }

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
  };
  const markMode = buildButtonRow<Mode>('mode', MODE_LABELS,
    (mode) => selectView(mode === 'synoptic' ? 'synoptic' : lastCloudView));
  const markView = buildButtonRow<CloudLabViewId>('views', entries, selectView);

  // モデルの調整値(uniform)をいじる行。スライダー・JSON 欄・uniform を揃えてから焼き直す。
  // 焼き直しは雲場 1 面ぶんの費用が掛かるので、ドラッグ中は止めず最後の変更から少し待って
  // 1 回だけ走らせる(uniform 自体は即時に書き変わり、天気の写しは焼き直しを待たずに乗る)。
  const setSliders = new Map<CloudTuningId, (value: number) => void>();
  const paramsBox = document.createElement('textarea');
  let bakeTimer: number | undefined;
  const rebake = (): void => {
    canvas.invalidate();
    if (currentView !== 'synoptic') canvas.render();
  };
  // rebakeNow は撮影口(window.cloudLab.setParams)のためのもの — 返った時点で焼き直しが
  // 済んでいることにして、呼び側がそのまま capture できるようにする。
  const applyParams = (next: Partial<Record<CloudTuningId, number>>, rebakeNow = false): void => {
    for (const [id, value] of Object.entries(next) as [CloudTuningId, number][]) {
      if (!(id in CLOUD_TUNING_DEFAULTS) || typeof value !== 'number' || !Number.isFinite(value)) continue;
      CLOUD_TUNING[id].value = value;
      setSliders.get(id)!(value);
    }
    paramsBox.value = JSON.stringify(Object.fromEntries(
      Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value])));
    window.clearTimeout(bakeTimer);
    if (rebakeNow) rebake();
    else bakeTimer = window.setTimeout(rebake, 250);
  };
  for (const [id, spec] of Object.entries(GENERATION_PARAMS) as [CloudTuningId, GenerationParamSpec][]) {
    setSliders.set(id, buildSlider(`p-${spec.row}`, spec.label, spec.min, spec.max, spec.step,
      () => String(CLOUD_TUNING[id].value), (value) => applyParams({ [id]: value })));
  }

  // 調整の共有用: いまの全パラメータの JSON。編集して「適用」で戻せる。「リセット」は既定値へ。
  const paramsRow = document.getElementById('p-json')!;
  paramsRow.appendChild(paramsBox);
  const copyButton = document.createElement('button');
  copyButton.textContent = 'コピー';
  copyButton.addEventListener('click', () => { void navigator.clipboard.writeText(paramsBox.value); });
  const applyButton = document.createElement('button');
  applyButton.textContent = '適用';
  applyButton.addEventListener('click', () => {
    try {
      applyParams(JSON.parse(paramsBox.value) as Partial<Record<CloudTuningId, number>>);
    } catch (e) {
      document.getElementById('error')!.textContent = `パラメータの JSON が読めない: ${String(e)}`;
    }
  });
  const resetButton = document.createElement('button');
  resetButton.textContent = 'リセット';
  resetButton.addEventListener('click', () => applyParams({ ...CLOUD_TUNING_DEFAULTS }));
  paramsRow.append(copyButton, applyButton, resetButton);
  applyParams(Object.fromEntries(
    Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value])) as Record<CloudTuningId, number>);

  // 最後に回した比較の評価値。撮影つきの比較(CLI)の結果なので、いま開いているパラメータの
  // 評価ではない — 未実行ならその旨だけ出す。
  const score = document.getElementById('score')!;
  void latestReportText('compare/latest.json').then((text) => {
    score.textContent = text ?? '評価 — (cloud-lab:compare 未実行)';
  });

  markMode('cloud');
  markView(canvas.currentView);
  showLegend(CLOUD_LAB_VIEWS.find((view) => view.id === canvas.currentView)!.legend);
  syncFraming();
  canvas.render();

  window.cloudLab = {
    // 撮影で読める写しは全列(畳んだ写像も含む)。ボタン列に出るのは畳んだあとの列だけ。
    views: [...CLOUD_LAB_VIEWS.map((view) => view.id), 'synoptic'],
    show: selectView,
    setTime: time.setHours,
    aimCap: (latitude, longitude, radius) => {
      canvas.aimCap(latitude, longitude, radius);
      if (currentView !== 'synoptic') canvas.render();
      syncFraming();
    },
    capture: async () => {
      if (currentView !== 'synoptic') return canvas.capture();
      // 天気図は焼きが残っているかもしれない — 終わるまで待って 2D canvas を拾う。
      await panel.settled();
      return mapCanvas.toDataURL('image/png');
    },
    cyclonesAt: (hours) => ({
      tropicals: Array.from(
        { length: TROPICAL_COUNT }, (_, index) => tropicalPlacementAt(index, hours * SECONDS_PER_HOUR)),
      lows: Array.from({ length: LOW_COUNT }, (_, index) => lowPlacementAt(index, hours * SECONDS_PER_HOUR, R_EARTH)),
      highs: Array.from({ length: HIGH_COUNT }, (_, index) => highPlacementAt(index, hours * SECONDS_PER_HOUR, R_EARTH)),
    }),
    params: () => Object.fromEntries(Object.entries(CLOUD_TUNING).map(([id, u]) => [id, u.value])),
    setParams: (next) => applyParams(next, true),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
