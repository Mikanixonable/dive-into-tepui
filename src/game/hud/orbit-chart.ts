// 折れ線グラフの描き手。渡された点列と軸をそのまま canvas 2D へ描く。何をプロットするかは知らない。
import { ACCENT, ACCENT_SOFT, EDGE, FONT_FAMILY, FONT_XXS, TEXT_DIM, TEXT_MUTED } from '../theme';
import { fmtDist, fmtDuration } from './utils';
import { chooseTickInterval } from './tick-scale';

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface ChartTick {
  readonly value: number;
  readonly label: string;
}

export interface ChartAxis {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly ChartTick[];
  readonly caption: string;
}

export interface ChartSpec {
  // null は「ここで線が切れる」印。折り返しをまたぐ点のように、繋ぐと実在しない線になる
  // 隣り合わせを分割する。
  readonly points: readonly (ChartPoint | null)[];
  readonly x: ChartAxis;
  readonly y: ChartAxis;
  readonly mark: ChartPoint | null;
  readonly emptyMessage?: string;
}

const ASPECT_RATIO = '16 / 9';
const PADDING_LEFT = 44;
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 34;
const TICK_LABEL_GAP = 4;
const X_CAPTION_OFFSET = 12;
const Y_CAPTION_MARGIN = 4;
const AXIS_LINE_WIDTH = 1;
const GRID_LINE_WIDTH = 1;
const CHART_LINE_WIDTH = 1.5;
const MARK_RADIUS = 3;
const MARK_RING_WIDTH = 1;

const STYLE = `
#hud .orbit-chart { display: block; width: 100%; aspect-ratio: ${ASPECT_RATIO}; }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

// 値域 [min, max] を長さ span の画面区間 [origin, origin+span] へ写す。min === max なら中央に固定する。
function scaleValue(value: number, min: number, max: number, origin: number, span: number, invert: boolean): number {
  const range = max - min;
  const ratio = range !== 0 ? (value - min) / range : 0.5;
  const offset = ratio * span;
  return invert ? origin + span - offset : origin + offset;
}

export class OrbitChart {
  public readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lastCssWidth = 0;
  private lastCssHeight = 0;
  private lastDpr = 0;

  public constructor() {
    ensureStyle();
    this.element = document.createElement('canvas');
    this.element.className = 'orbit-chart';
    const ctx = this.element.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    this.ctx = ctx;
  }

  public dispose(): void {
  }

  public draw(spec: ChartSpec): void {
    this.resizeBackingStoreIfNeeded();
    const ctx = this.ctx;
    const cssWidth = this.lastCssWidth;
    const cssHeight = this.lastCssHeight;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (cssWidth <= 0 || cssHeight <= 0) return;

    const plotLeft = PADDING_LEFT;
    const plotRight = cssWidth - PADDING_RIGHT;
    const plotTop = PADDING_TOP;
    const plotBottom = cssHeight - PADDING_BOTTOM;
    const plotWidth = plotRight - plotLeft;
    const plotHeight = plotBottom - plotTop;
    if (plotWidth <= 0 || plotHeight <= 0) return;

    ctx.font = `${FONT_XXS} ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';

    this.drawGrid(spec, plotLeft, plotTop, plotWidth, plotHeight);
    this.drawFrame(plotLeft, plotTop, plotWidth, plotHeight);
    this.drawCaptions(spec, plotLeft, plotRight, cssHeight);

    if (!spec.points.some((point) => point !== null)) {
      this.drawEmptyMessage(spec.emptyMessage ?? '', plotLeft, plotTop, plotWidth, plotHeight);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();
    this.drawLine(spec, plotLeft, plotTop, plotWidth, plotHeight);
    if (spec.mark) this.drawMark(spec.mark, spec, plotLeft, plotTop, plotWidth, plotHeight);
    ctx.restore();
  }

  private resizeBackingStoreIfNeeded(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = this.element.clientWidth;
    const cssHeight = this.element.clientHeight;
    if (cssWidth === this.lastCssWidth && cssHeight === this.lastCssHeight && dpr === this.lastDpr) return;
    this.lastCssWidth = cssWidth;
    this.lastCssHeight = cssHeight;
    this.lastDpr = dpr;
    this.element.width = Math.max(1, Math.round(cssWidth * dpr));
    this.element.height = Math.max(1, Math.round(cssHeight * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private drawGrid(spec: ChartSpec, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    const plotBottom = plotTop + plotHeight;
    const plotRight = plotLeft + plotWidth;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.fillStyle = TEXT_DIM;

    ctx.textAlign = 'center';
    for (const tick of spec.x.ticks) {
      const px = scaleValue(tick.value, spec.x.min, spec.x.max, plotLeft, plotWidth, false);
      ctx.beginPath();
      ctx.moveTo(px, plotTop);
      ctx.lineTo(px, plotBottom);
      ctx.stroke();
      ctx.fillText(tick.label, px, plotBottom + TICK_LABEL_GAP + X_CAPTION_OFFSET / 2);
    }

    ctx.textAlign = 'right';
    for (const tick of spec.y.ticks) {
      const py = scaleValue(tick.value, spec.y.min, spec.y.max, plotTop, plotHeight, true);
      ctx.beginPath();
      ctx.moveTo(plotLeft, py);
      ctx.lineTo(plotRight, py);
      ctx.stroke();
      ctx.fillText(tick.label, plotLeft - TICK_LABEL_GAP, py);
    }
  }

  private drawFrame(plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = AXIS_LINE_WIDTH;
    ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
  }

  private drawCaptions(spec: ChartSpec, plotLeft: number, plotRight: number, cssHeight: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = TEXT_MUTED;
    ctx.textAlign = 'center';
    ctx.fillText(spec.x.caption, (plotLeft + plotRight) / 2, cssHeight - X_CAPTION_OFFSET / 2);
    ctx.textAlign = 'left';
    ctx.fillText(spec.y.caption, Y_CAPTION_MARGIN, PADDING_TOP / 2);
  }

  private drawEmptyMessage(message: string, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText(message, plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
  }

  private drawLine(spec: ChartSpec, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = CHART_LINE_WIDTH;
    ctx.beginPath();
    let penDown = false;
    for (const point of spec.points) {
      if (point === null) {
        penDown = false;
        continue;
      }
      const px = scaleValue(point.x, spec.x.min, spec.x.max, plotLeft, plotWidth, false);
      const py = scaleValue(point.y, spec.y.min, spec.y.max, plotTop, plotHeight, true);
      if (penDown) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      penDown = true;
    }
    ctx.stroke();
  }

  private drawMark(
    mark: ChartPoint,
    spec: ChartSpec,
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
  ): void {
    const ctx = this.ctx;
    const px = scaleValue(mark.x, spec.x.min, spec.x.max, plotLeft, plotWidth, false);
    const py = scaleValue(mark.y, spec.y.min, spec.y.max, plotTop, plotHeight, true);
    ctx.fillStyle = ACCENT_SOFT;
    ctx.beginPath();
    ctx.arc(px, py, MARK_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = MARK_RING_WIDTH;
    ctx.stroke();
  }
}

// 0 秒から spanSec までの時間軸。目盛り間隔は chooseTickInterval が選ぶ。
export function timeAxis(spanSec: number, maxTicks: number, caption: string): ChartAxis {
  const span = isFinite(spanSec) && spanSec > 0 ? spanSec : 0;
  if (span === 0) return { min: 0, max: 0, ticks: [], caption };
  const interval = chooseTickInterval(span, maxTicks);
  const ticks: ChartTick[] = [];
  for (let value = 0; value <= span; value += interval) {
    ticks.push({ value, label: fmtDuration(value, interval) });
  }
  return { min: 0, max: span, ticks, caption };
}

// 距離目盛りの候補ラダー [km]、小さい順。1, 2, 5 × 10^n。
const DISTANCE_TICK_INTERVALS_KM = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000,
] as const;

// spanKm の目盛り本数が maxTicks を超えない最小の間隔 [km] を選ぶ。どの候補でも超えるなら最大の候補を返す。
function chooseDistanceTickIntervalKm(spanKm: number, maxTicks: number): number {
  let interval: number = DISTANCE_TICK_INTERVALS_KM[0];
  if (!isFinite(spanKm) || spanKm <= 0) return interval;
  for (const candidate of DISTANCE_TICK_INTERVALS_KM) {
    interval = candidate;
    if (Math.floor(spanKm / candidate) + 1 <= maxTicks) break;
  }
  return interval;
}

// centerM を中央に置いた幅 spanM の距離軸 [m]。目盛りは km 単位のラダーから選ぶ。
export function distanceAxis(centerM: number, spanM: number, maxTicks: number, caption: string): ChartAxis {
  const span = isFinite(spanM) && spanM > 0 ? spanM : 0;
  const center = isFinite(centerM) ? centerM : 0;
  if (span === 0) return { min: center, max: center, ticks: [], caption };
  const min = center - span / 2;
  const max = center + span / 2;
  const intervalM = chooseDistanceTickIntervalKm(span / 1000, maxTicks) * 1000;
  const firstTick = Math.ceil(min / intervalM) * intervalM;
  const ticks: ChartTick[] = [];
  for (let value = firstTick; value <= max; value += intervalM) {
    ticks.push({ value, label: fmtDist(value) });
  }
  return { min, max, ticks, caption };
}
