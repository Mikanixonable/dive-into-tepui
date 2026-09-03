// 折れ線グラフの描き手。渡された点列・軸・マークだけを canvas 2D へ描く汎用エンジンで、
// 単位系や意味づけは軸構築側(orbit-chart-axes.ts)と呼び出し側が持つ。
import { ACCENT, EDGE, FONT_FAMILY, FONT_XXS, TEXT_DIM, TEXT_MUTED } from '../../../theme';
import { injectOnce } from '../widgets/inject-style';
import {
  CHART_LINE_WIDTH, CHART_MARK_RADIUS, CHART_MARK_RING_WIDTH, chartCanvasStyle,
  drawPointMarker, drawPolylineWithGaps, resizeCanvasBackingStore, type BackingStoreState,
} from './chart-canvas';

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

export interface ChartMark {
  readonly point: ChartPoint;
  // 'current' = 現在地点(塗り丸)。'target' = ターゲット位置(縁だけの丸)。
  readonly style: 'current' | 'target';
}

export interface ChartSpec {
  // null は「ここで線が切れる」印。折り返しをまたぐ点のように、繋ぐと実在しない線になる
  // 隣り合わせを分割する。
  readonly points: readonly (ChartPoint | null)[];
  readonly x: ChartAxis;
  readonly y: ChartAxis;
  readonly marks: readonly ChartMark[];
  readonly emptyMessage?: string;
}

const PADDING_LEFT = 44;
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 34;
const TICK_LABEL_GAP = 4;
const X_CAPTION_OFFSET = 12;
const Y_CAPTION_MARGIN = 4;
const AXIS_LINE_WIDTH = 1;
const GRID_LINE_WIDTH = 1;

const STYLE = chartCanvasStyle('orbit-chart');

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
  private readonly backing: BackingStoreState = { cssWidth: 0, cssHeight: 0, dpr: 0 };

  // canvas 要素を作り、2D コンテキストを確保する。
  public constructor() {
    injectOnce('orbit-chart', STYLE);
    this.element = document.createElement('canvas');
    this.element.className = 'orbit-chart';
    const ctx = this.element.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    this.ctx = ctx;
  }

  public dispose(): void {
  }

  // 直近の draw() が描いたプロット領域のピクセル寸法。まだ描いていない/寸法0なら null
  // ——呼び出し側がドラッグ移動量を軸の値へ換算する変換係数として使う。
  public plotPixelSize(): { width: number; height: number } | null {
    const width = this.backing.cssWidth - PADDING_LEFT - PADDING_RIGHT;
    const height = this.backing.cssHeight - PADDING_TOP - PADDING_BOTTOM;
    return width > 0 && height > 0 ? { width, height } : null;
  }

  // spec の軸・マーク・点列を、この順(グリッド→外枠→キャプション→線→マーク)で描き直す。
  // 点が1つも無ければ折れ線の代わりに emptyMessage を出す。
  public draw(spec: ChartSpec): void {
    resizeCanvasBackingStore(this.element, this.ctx, this.backing);
    const ctx = this.ctx;
    const cssWidth = this.backing.cssWidth;
    const cssHeight = this.backing.cssHeight;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (cssWidth <= 0 || cssHeight <= 0) return;

    // プロット領域(軸・キャプション分の余白を除いた矩形)を確定する。
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

    // 折れ線・マークはプロット領域内にクリップする——値がプロット範囲外に出ても
    // 軸ラベルの上へはみ出さない。
    if (!spec.points.some((point) => point !== null)) {
      this.drawEmptyMessage(spec.emptyMessage ?? '', plotLeft, plotTop, plotWidth, plotHeight);
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();
    this.drawLine(spec, plotLeft, plotTop, plotWidth, plotHeight);
    for (const mark of spec.marks) this.drawMark(mark, spec, plotLeft, plotTop, plotWidth, plotHeight);
    ctx.restore();
  }

  // x/y 軸それぞれの目盛り線とラベルを描く。
  private drawGrid(spec: ChartSpec, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    const plotBottom = plotTop + plotHeight;
    const plotRight = plotLeft + plotWidth;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.fillStyle = TEXT_DIM;

    // x軸: 縦の目盛り線を下端のラベルとともに描く。
    ctx.textAlign = 'center';
    for (const tick of spec.x.ticks) {
      const px = scaleValue(tick.value, spec.x.min, spec.x.max, plotLeft, plotWidth, false);
      ctx.beginPath();
      ctx.moveTo(px, plotTop);
      ctx.lineTo(px, plotBottom);
      ctx.stroke();
      ctx.fillText(tick.label, px, plotBottom + TICK_LABEL_GAP + X_CAPTION_OFFSET / 2);
    }

    // y軸: 横の目盛り線を左端のラベルとともに描く。
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

  // プロット領域の外枠。
  private drawFrame(plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = AXIS_LINE_WIDTH;
    ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
  }

  // x軸・y軸それぞれのキャプション文字列。
  private drawCaptions(spec: ChartSpec, plotLeft: number, plotRight: number, cssHeight: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = TEXT_MUTED;
    ctx.textAlign = 'center';
    ctx.fillText(spec.x.caption, (plotLeft + plotRight) / 2, cssHeight - X_CAPTION_OFFSET / 2);
    ctx.textAlign = 'left';
    ctx.fillText(spec.y.caption, Y_CAPTION_MARGIN, PADDING_TOP / 2);
  }

  // プロット領域の中央に表示する案内文。
  private drawEmptyMessage(message: string, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText(message, plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
  }

  // spec.points を折れ線として描く。
  private drawLine(spec: ChartSpec, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const toPx = (point: ChartPoint): { x: number; y: number } => ({
      x: scaleValue(point.x, spec.x.min, spec.x.max, plotLeft, plotWidth, false),
      y: scaleValue(point.y, spec.y.min, spec.y.max, plotTop, plotHeight, true),
    });
    drawPolylineWithGaps(this.ctx, spec.points, toPx, ACCENT, CHART_LINE_WIDTH);
  }

  // mark.style に応じた丸マークを1点描く。
  private drawMark(
    mark: ChartMark,
    spec: ChartSpec,
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
  ): void {
    const px = scaleValue(mark.point.x, spec.x.min, spec.x.max, plotLeft, plotWidth, false);
    const py = scaleValue(mark.point.y, spec.y.min, spec.y.max, plotTop, plotHeight, true);
    drawPointMarker(this.ctx, px, py, mark.style === 'current', CHART_MARK_RADIUS, CHART_MARK_RING_WIDTH);
  }
}
