// 投影タブの描き手。円筒図法テクスチャを背景に、経緯度グリッド・複数系統の軌跡・現在位置を
// canvas 2D へ描く。軸は経度[-180,180]・緯度[-90,90]に固定(ズーム・パンは行わない)。
import { ACCENT, ACCENT_SOFT, EDGE, FONT_FAMILY, FONT_XXS, TEXT_DIM, TEXT_STRONG } from '../../theme';

export interface ProjectionPoint { readonly lonDeg: number; readonly latDeg: number }

export interface ProjectionSeriesSpec {
  readonly points: readonly (ProjectionPoint | null)[];
  readonly current: ProjectionPoint;
  readonly color: string;
  // 現在位置を塗り丸(自艦)にするか、縁だけの丸(ターゲット)にするか。
  readonly currentStyle: 'filled' | 'ring';
}

export interface ProjectionChartSpec {
  readonly textureImage: HTMLImageElement | null;
  readonly series: readonly ProjectionSeriesSpec[];
  readonly emptyMessage?: string;
}

const ASPECT_RATIO = '16 / 9';
const PADDING_LEFT = 30;
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 20;
const GRID_STEP_DEG = 30;
const LINE_WIDTH = 1.5;
const MARK_RADIUS = 3;
const MARK_RING_WIDTH = 1;

const STYLE = `
#hud .orbit-projection-chart { display: block; width: 100%; aspect-ratio: ${ASPECT_RATIO}; }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function lonLabel(deg: number): string {
  if (deg === -180 || deg === 180) return '180°';
  return deg === 0 ? '0°' : `${Math.abs(deg)}°${deg > 0 ? 'E' : 'W'}`;
}

function latLabel(deg: number): string {
  return deg === 0 ? '0°' : `${Math.abs(deg)}°${deg > 0 ? 'N' : 'S'}`;
}

export class OrbitProjectionChart {
  public readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lastCssWidth = 0;
  private lastCssHeight = 0;
  private lastDpr = 0;

  public constructor() {
    ensureStyle();
    this.element = document.createElement('canvas');
    this.element.className = 'orbit-projection-chart';
    const ctx = this.element.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    this.ctx = ctx;
  }

  public dispose(): void {
  }

  // 背景(テクスチャ or 空メッセージ)→グリッド→各系列の折れ線・現在位置マークの順に描く。
  // プロット領域は常に全球固定(軸のスケール入力・ドラッグ/ズームは持たない)。
  public draw(spec: ProjectionChartSpec): void {
    this.resizeBackingStoreIfNeeded();
    const ctx = this.ctx;
    const cssWidth = this.lastCssWidth;
    const cssHeight = this.lastCssHeight;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (cssWidth <= 0 || cssHeight <= 0) return;

    const plotLeft = PADDING_LEFT;
    const plotTop = PADDING_TOP;
    const plotWidth = cssWidth - PADDING_LEFT - PADDING_RIGHT;
    const plotHeight = cssHeight - PADDING_TOP - PADDING_BOTTOM;
    if (plotWidth <= 0 || plotHeight <= 0) return;

    ctx.font = `${FONT_XXS} ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';

    if (spec.textureImage) ctx.drawImage(spec.textureImage, plotLeft, plotTop, plotWidth, plotHeight);
    else {
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText(spec.emptyMessage ?? '', plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
    }
    this.drawGrid(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();
    for (const series of spec.series) this.drawSeries(series, plotLeft, plotTop, plotWidth, plotHeight);
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

  private toPx(lonDeg: number, latDeg: number, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): { x: number; y: number } {
    return {
      x: plotLeft + ((lonDeg + 180) / 360) * plotWidth,
      y: plotTop + ((90 - latDeg) / 180) * plotHeight,
    };
  }

  private drawGrid(plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    ctx.fillStyle = TEXT_DIM;

    ctx.textAlign = 'center';
    for (let lon = -180; lon <= 180; lon += GRID_STEP_DEG) {
      const { x } = this.toPx(lon, 0, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotHeight);
      ctx.stroke();
      ctx.fillText(lonLabel(lon), x, plotTop + plotHeight + 10);
    }

    ctx.textAlign = 'left';
    for (let lat = -90; lat <= 90; lat += GRID_STEP_DEG) {
      const { y } = this.toPx(0, lat, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
      ctx.fillText(latLabel(lat), 2, y);
    }
  }

  private drawSeries(series: ProjectionSeriesSpec, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = series.color;
    ctx.lineWidth = LINE_WIDTH;
    ctx.beginPath();
    let penDown = false;
    for (const point of series.points) {
      if (point === null) { penDown = false; continue; }
      const { x, y } = this.toPx(point.lonDeg, point.latDeg, plotLeft, plotTop, plotWidth, plotHeight);
      if (penDown) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
    }
    ctx.stroke();

    const { x, y } = this.toPx(series.current.lonDeg, series.current.latDeg, plotLeft, plotTop, plotWidth, plotHeight);
    ctx.beginPath();
    ctx.arc(x, y, MARK_RADIUS, 0, Math.PI * 2);
    if (series.currentStyle === 'filled') {
      ctx.fillStyle = ACCENT_SOFT;
      ctx.fill();
      ctx.strokeStyle = ACCENT;
    } else {
      ctx.strokeStyle = TEXT_STRONG;
    }
    ctx.lineWidth = MARK_RING_WIDTH;
    ctx.stroke();
  }
}
