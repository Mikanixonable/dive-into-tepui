// 雲の実験環境の画面。表示する量を選び、時刻を動かして、天気のモデルの写しを正距円筒で見る。
import { CloudLabCanvas } from './lab';
import { CLOUD_LAB_VIEWS, type CloudLabViewId } from './views';
import { buildButtonRow, buildSlider, buildToggleField } from '../lab-controls';

const HOURS_PER_DAY = 24;
// 再生中に実時間 1 秒あたり進める時刻 [h]。
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
    };
  }
}

// 時刻を決めるつまみ 1 本。0 から maxHours [h] までの区間を指す。
interface TimeSlider {
  readonly maxHours: number;
  readonly hours: number;
  // 指す時刻 [h] を置き直し、つまみと読み出しを合わせる。
  set: (hours: number) => void;
}

// 時刻のつまみを 1 本組む。format は指している時刻 [h] を読み出しの文字にし、人がつまみを
// 動かしたときに change が呼ばれる。
function buildTimeSlider(
  label: string, maxHours: number, stepHours: number,
  format: (hours: number) => string, change: () => void,
): TimeSlider {
  let hours = 0;
  const setKnob = buildSlider('time', label, 0, maxHours, stepHours,
    () => format(hours), (value) => { hours = value; change(); });
  return {
    maxHours,
    get hours(): number { return hours; },
    set: (value) => { hours = value; setKnob(value); },
  };
}

// 器を起こし、操作部品を配線し、撮影の入口を window へ出す。
async function init(): Promise<void> {
  const canvas = await CloudLabCanvas.create(document.getElementById('view') as HTMLCanvasElement);

  const entries = CLOUD_LAB_VIEWS.map((view) => [view.id, view.label] as const);
  const markView = buildButtonRow<CloudLabViewId>('views', entries, (id) => {
    markView(id);
    canvas.show(id);
  });

  // 時刻は 3 本のつまみの和。細い側が短い周期の動きを刻み、粗い側がその窓を先へ送る。
  const applyTime = (): void => {
    canvas.setTime(timeSliders.reduce((sum, slider) => sum + slider.hours, 0));
  };
  const shortTermSlider = buildTimeSlider('72 時間', 72, 0.1,
    (hours) => `${hours.toFixed(1)} h`, applyTime);
  const timeSliders: readonly TimeSlider[] = [
    shortTermSlider,
    buildTimeSlider('30 日', 30 * HOURS_PER_DAY, HOURS_PER_DAY / 10,
      (hours) => `${(hours / HOURS_PER_DAY).toFixed(1)} d`, applyTime),
    buildTimeSlider('1 年', 365 * HOURS_PER_DAY, HOURS_PER_DAY,
      (hours) => `${(hours / HOURS_PER_DAY).toFixed(0)} d`, applyTime),
  ];
  // 時刻 [h] を 3 本へ割り振って入れ直す。細い側から順にその幅で割った余りを取り、いちばん
  // 粗い 1 本が残りを受けるので、和は元の時刻に戻る。
  const setTime = (hours: number): void => {
    let rest = hours;
    for (const [index, slider] of timeSliders.entries()) {
      const part = index === timeSliders.length - 1 ? rest : rest % slider.maxHours;
      slider.set(part);
      rest -= part;
    }
    applyTime();
  };

  let playing = false;
  let lastFrameMs = 0;
  // 再生中の 1 フレーム。いちばん細いつまみを実時間に比例して進め、上限で頭から繰り返す。
  const advance = (nowMs: number): void => {
    if (!playing) return;
    const elapsedHours = ((nowMs - lastFrameMs) / 1000) * PLAY_HOURS_PER_SECOND;
    lastFrameMs = nowMs;
    shortTermSlider.set((shortTermSlider.hours + elapsedHours) % shortTermSlider.maxHours);
    applyTime();
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

  markView(canvas.currentView);
  setTime(canvas.hours);
  setCapLatitude(canvas.capCenterLatitude);
  setCapLongitude(canvas.capCenterLongitude);
  setCapRadius(canvas.capAngularRadius);
  canvas.render();

  window.cloudLab = {
    views: CLOUD_LAB_VIEWS.map((view) => view.id),
    show: (id) => { markView(id); canvas.show(id); },
    setTime,
    aimCap: (latitude, longitude, radius) => {
      canvas.aimCap(latitude, longitude, radius);
      setCapLatitude(latitude);
      setCapLongitude(longitude);
      setCapRadius(radius);
    },
    capture: () => canvas.capture(),
  };
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
