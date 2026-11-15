// 時刻の操作行。再生・速度・経過のつまみを 1 行に組み、時刻の正本を持つ。
// 経過のつまみは速度ごとに見る窓を変える。窓の長さで目盛りの細かさが決まり、< > で窓を送る幅も決まる。
// 速度が遅いほど細かく動かせ、速いほど大きく送れる。
import { buildChoiceSlider, buildScaleSlider } from '../lab-controls';
import { HOURS_PER_DAY, SECONDS_PER_HOUR, YEAR_HOURS, wrapYear } from './time-units';
import type { ScaleTick } from '../lab-controls';

const SECONDS_PER_DAY = HOURS_PER_DAY * SECONDS_PER_HOUR;
// 窓をつまみの何段で割るか。窓が 1 日なら約 22 秒、1 年なら約 2 時間の段になる。
const STEPS_PER_WINDOW = 4000;
const DEFAULT_SPEED_INDEX = 2;

interface SpeedScale {
  readonly speed: number; // 実時間 1 秒に進むモデルの時間 [h]
  readonly windowHours: number; // 経過つまみが見る時間の長さ [h]
  readonly tickHours: number; // 目盛りの刻み [h]
}
// 速度ごとの窓と目盛り。×1 は実時間 1 秒 = モデル 1 時間。
const SPEED_SCALES: readonly SpeedScale[] = [
  { speed: 0.25, windowHours: HOURS_PER_DAY, tickHours: 3 },
  { speed: 0.5, windowHours: 2 * HOURS_PER_DAY, tickHours: 6 },
  { speed: 1, windowHours: 7 * HOURS_PER_DAY, tickHours: HOURS_PER_DAY },
  { speed: 2, windowHours: 30 * HOURS_PER_DAY, tickHours: 5 * HOURS_PER_DAY },
  { speed: 4, windowHours: 90 * HOURS_PER_DAY, tickHours: 30 * HOURS_PER_DAY },
  { speed: 8, windowHours: YEAR_HOURS, tickHours: 60 * HOURS_PER_DAY },
];

interface TimeControls {
  readonly hours: number;
  setHours(hours: number): void;
}

// 0 からの経過を「5 日 07:12」の形で出す。細かい窓では秒まで出し、つまみの一段が読めるようにする。
// モデルは暦を持たないので、日付にはしない。
function formatElapsed(hours: number, withSeconds: boolean): string {
  const seconds = Math.round(hours * SECONDS_PER_HOUR);
  const restSeconds = seconds % SECONDS_PER_DAY;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const clock = `${pad(Math.floor(restSeconds / SECONDS_PER_HOUR))}:${pad(Math.floor(restSeconds / 60) % 60)}`;
  const second = withSeconds ? `:${pad(restSeconds % 60)}` : '';
  return `${Math.floor(seconds / SECONDS_PER_DAY)} 日 ${clock}${second}`;
}

// 目盛りの文字。日の区切りは「N 日」、それ以外は「HH:00」。
function tickLabel(hours: number): string {
  return hours % HOURS_PER_DAY === 0
    ? `${hours / HOURS_PER_DAY} 日`
    : `${String(hours % HOURS_PER_DAY).padStart(2, '0')}:00`;
}

// 窓 [start, end] の中の目盛り。刻みは 0 時から数えた倍数に揃える。
function ticksIn(start: number, end: number, tickHours: number): ScaleTick[] {
  const ticks: ScaleTick[] = [];
  for (let at = Math.ceil(start / tickHours) * tickHours; at <= end; at += tickHours) {
    ticks.push({ at, label: tickLabel(at) });
  }
  return ticks;
}

function appendButton(row: HTMLElement, text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = text;
  button.title = title;
  button.addEventListener('click', onClick);
  row.appendChild(button);
  return button;
}

// 行 rowId に時刻の操作を組む。時刻が動くたび(つまみ・再生・窓の送り・setHours)に onHours を呼ぶ。
export function buildTimeControls(
  rowId: string, initialHours: number, onHours: (hours: number) => void,
): TimeControls {
  const row = document.getElementById(rowId)!;
  let hours = initialHours;
  let speedIndex = DEFAULT_SPEED_INDEX;
  let windowStart = 0;
  let windowEnd = 0;
  let playing = false;
  let playFrame = 0;
  let lastFrameMs = 0;
  const scale = (): SpeedScale => SPEED_SCALES[speedIndex]!;

  const playButton = document.createElement('button');
  playButton.className = 'play';
  playButton.title = '再生 / 一時停止';
  playButton.textContent = '▶';
  playButton.addEventListener('click', () => setPlaying(!playing));
  row.appendChild(playButton);

  const speed = buildChoiceSlider(rowId, '速度', '320px', SPEED_SCALES.map((item) => `×${item.speed}`),
    (index) => {
      speedIndex = index;
      openWindow();
    });
  const prevButton = appendButton(row, '<', '前の窓へ送る', () => page(-1));
  const fineReadout = (): boolean => scale().windowHours <= 2 * HOURS_PER_DAY;
  const elapsed = buildScaleSlider(rowId, '経過', 'min(480px, 36vw)',
    () => formatElapsed(hours, fineReadout()), (value) => dragged(value));
  const nextButton = appendButton(row, '>', '次の窓へ送る', () => page(1));

  // 速度の窓を、いまの時刻を含む区切りに開く。範囲と目盛りもここで組み直す。
  const openWindow = (): void => {
    const { windowHours, tickHours } = scale();
    windowStart = Math.floor(hours / windowHours) * windowHours;
    // 年の内では窓を年末で切る。年を出た時刻を外から置いたときは、その時刻を含むよう切らない。
    const end = windowStart + windowHours;
    windowEnd = hours < YEAR_HOURS ? Math.min(end, YEAR_HOURS) : end;
    // 1 年の窓はつまみが全体を覆うので、窓の送りは要らない。
    prevButton.disabled = windowHours >= YEAR_HOURS;
    nextButton.disabled = prevButton.disabled;
    elapsed.setScale({
      min: windowStart, max: windowEnd, step: windowHours / STEPS_PER_WINDOW,
      ticks: ticksIn(windowStart, windowEnd, tickHours),
    });
    elapsed.setValue(hours);
  };

  // つまみを引いた時刻。引いている値は窓の中なので窓は動かさない(端で窓を送ると、つまみが飛び続ける)。
  const dragged = (value: number): void => {
    hours = value;
    onHours(hours);
  };
  // 時刻を置く。窓を出たら、その時刻を含む窓へ開き直し、つまみも合わせる。外から置く時刻は循環させない。
  const place = (next: number): void => {
    hours = next;
    if (hours < windowStart || hours >= windowEnd) openWindow();
    else elapsed.setValue(hours);
    onHours(hours);
  };

  // 窓を 1 つ送る。送る幅は窓の長さなので、速度を上げるほど大きく動く。年の中で循環させる。
  const page = (direction: 1 | -1): void => place(wrapYear(hours + direction * scale().windowHours));

  // 再生中の 1 フレーム。実時間に速度を掛けて時刻を進め、1 年で頭から繰り返す。
  const advance = (nowMs: number): void => {
    place(wrapYear(hours + ((nowMs - lastFrameMs) / 1000) * scale().speed));
    lastFrameMs = nowMs;
    playFrame = requestAnimationFrame(advance);
  };
  const setPlaying = (on: boolean): void => {
    playing = on;
    playButton.textContent = on ? '⏸' : '▶';
    playButton.setAttribute('aria-label', on ? '一時停止' : '再生');
    cancelAnimationFrame(playFrame);
    if (!on) return;
    lastFrameMs = performance.now();
    playFrame = requestAnimationFrame(advance);
  };

  speed.setValue(speedIndex);
  openWindow();
  return {
    get hours(): number { return hours; },
    setHours: place,
  };
}
