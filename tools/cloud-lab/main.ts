// 雲の実験環境の画面。表示する量を選び、時刻とつまみを動かして、天気のモデルの写しを正距円筒で見る。
import { CloudLabCanvas } from './lab';
import { CLOUD_TUNING_KNOBS, cloudTuningValues } from './tuning-knobs';
import { CLOUD_LAB_VIEWS, type CloudLabViewId } from './views';
import { buildButtonRow, buildSlider, buildToggleField } from '../lab-controls';

// 時刻スライダーの上限 [h] と、再生中に実時間 1 秒あたり進める時刻 [h]。
const MAX_HOURS = 72;
const PLAY_HOURS_PER_SECOND = 1;

declare global {
  interface Window {
    // 撮影の駆動(tools/cloud-lab-shot.mjs・tools/cloud-lab-compare.mjs)が CDP から読む入口。
    cloudLab?: {
      views: readonly CloudLabViewId[];
      show: (id: CloudLabViewId) => void;
      setTime: (hours: number) => void;
      aimCap: (latitude: number, longitude: number, radius: number) => void;
      capture: () => Promise<string>;
      params: () => Record<string, number>;
      setParams: (values: Readonly<Record<string, number>>) => void;
    };
  }
}

// 器を起こし、操作部品を配線し、撮影の入口を window へ出す。
async function init(): Promise<void> {
  const canvas = await CloudLabCanvas.create(document.getElementById('view') as HTMLCanvasElement);

  const entries = CLOUD_LAB_VIEWS.map((view) => [view.id, view.label] as const);
  const markView = buildButtonRow<CloudLabViewId>('views', entries, (id) => {
    markView(id);
    canvas.show(id);
  });
  const setSlider = buildSlider('time', '時刻', 0, MAX_HOURS, 0.1,
    () => `${canvas.hours.toFixed(1)} h`, (hours) => canvas.setTime(hours));

  let playing = false;
  let lastFrameMs = 0;
  // 再生中の 1 フレーム。実時間に比例して時刻を進め、上限で頭から繰り返す。
  const advance = (nowMs: number): void => {
    if (!playing) return;
    const hours = (canvas.hours + ((nowMs - lastFrameMs) / 1000) * PLAY_HOURS_PER_SECOND) % MAX_HOURS;
    lastFrameMs = nowMs;
    canvas.setTime(hours);
    setSlider(hours);
    requestAnimationFrame(advance);
  };
  const markPlaying = buildToggleField('time', '再生', (on) => {
    playing = on;
    markPlaying(on);
    if (!on) return;
    lastFrameMs = performance.now();
    requestAnimationFrame(advance);
  });

  // cap の面の写す範囲。3 本のスライダーは、動かした 1 本といまの残り 2 つで置き直す。
  const setCapLatitude = buildSlider('cap', 'cap 中心緯度', -90, 90, 1,
    () => `${canvas.capCenterLatitude.toFixed(0)}°`,
    (latitude) => canvas.aimCap(latitude, canvas.capCenterLongitude, canvas.capAngularRadius));
  const setCapLongitude = buildSlider('cap', '中心経度', -180, 180, 1,
    () => `${canvas.capCenterLongitude.toFixed(0)}°`,
    (longitude) => canvas.aimCap(canvas.capCenterLatitude, longitude, canvas.capAngularRadius));
  const setCapRadius = buildSlider('cap', '半径', 1, 90, 1,
    () => `${canvas.capAngularRadius.toFixed(0)}°`,
    (radius) => canvas.aimCap(canvas.capCenterLatitude, canvas.capCenterLongitude, radius));

  // つまみをまとめて置き直す入口。uniform・スライダー・JSON 欄を揃えてから 1 回だけ描き直す。
  const setKnobs = new Map<string, (value: number) => void>();
  const paramsBox = document.createElement('textarea');
  const applyParams = (next: Readonly<Record<string, number>>): void => {
    for (const knob of CLOUD_TUNING_KNOBS) {
      const value = next[knob.id];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      knob.value.value = value;
      setKnobs.get(knob.id)!(value);
    }
    paramsBox.value = JSON.stringify(cloudTuningValues());
    canvas.render();
  };
  for (const knob of CLOUD_TUNING_KNOBS) {
    setKnobs.set(knob.id, buildSlider(knob.row, knob.label, knob.min, knob.max, knob.step,
      () => String(knob.value.value), (value) => applyParams({ [knob.id]: value })));
  }

  // 調整の共有用: いまの全つまみの JSON。編集して「適用」で戻せる。
  const paramsRow = document.getElementById('params')!;
  paramsRow.appendChild(paramsBox);
  const copyButton = document.createElement('button');
  copyButton.textContent = 'コピー';
  copyButton.addEventListener('click', () => { void navigator.clipboard.writeText(paramsBox.value); });
  const applyButton = document.createElement('button');
  applyButton.textContent = '適用';
  applyButton.addEventListener('click', () => {
    try {
      applyParams(JSON.parse(paramsBox.value) as Record<string, number>);
    } catch (e) {
      document.getElementById('error')!.textContent = `つまみの JSON が読めない: ${String(e)}`;
    }
  });
  paramsRow.append(copyButton, applyButton);

  markView(canvas.currentView);
  setSlider(canvas.hours);
  setCapLatitude(canvas.capCenterLatitude);
  setCapLongitude(canvas.capCenterLongitude);
  setCapRadius(canvas.capAngularRadius);
  applyParams(cloudTuningValues());

  window.cloudLab = {
    views: CLOUD_LAB_VIEWS.map((view) => view.id),
    show: (id) => { markView(id); canvas.show(id); },
    setTime: (hours) => { canvas.setTime(hours); setSlider(hours); },
    aimCap: (latitude, longitude, radius) => {
      canvas.aimCap(latitude, longitude, radius);
      setCapLatitude(latitude);
      setCapLongitude(longitude);
      setCapRadius(radius);
    },
    capture: () => canvas.capture(),
    params: cloudTuningValues,
    setParams: applyParams,
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
