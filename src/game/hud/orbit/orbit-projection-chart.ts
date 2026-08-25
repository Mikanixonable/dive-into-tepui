// 投影タブの描き手。円筒図法テクスチャを背景に、経緯度グリッド・複数系統の軌跡・現在位置を
// canvas 2D へ描く。表示範囲(中心経緯度・ズーム)を自分で持ち、pan/zoom/resetView で操作する。
import { EDGE, FONT_FAMILY, FONT_XXS, TEXT_DIM } from '../../theme';
import { injectOnce } from '../widgets/inject-style';
import { drawPointMarker, drawPolylineWithGaps, resizeCanvasBackingStore, type BackingStoreState } from './chart-canvas';

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

interface Window { lonMin: number; lonMax: number; latMin: number; latMax: number }

const ASPECT_RATIO = '16 / 9';
const PADDING_LEFT = 30;
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 20;
const GRID_STEP_DEG = 30;
const LINE_WIDTH = 1.5;
const MARK_RADIUS = 3;
const MARK_RING_WIDTH = 1;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

const STYLE = `
#hud .orbit-projection-chart { display: block; width: 100%; aspect-ratio: ${ASPECT_RATIO}; }
#hud .orbit-projection-chart.panzoom { touch-action: none; cursor: grab; }
#hud .orbit-projection-chart.panzoom:active { cursor: grabbing; }
`;

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
  private readonly backing: BackingStoreState = { cssWidth: 0, cssHeight: 0, dpr: 0 };
  private lastPlotWidth = 0;
  private lastPlotHeight = 0;
  private centerLon = 0;
  private centerLat = 0;
  private zoomLevel = ZOOM_MIN;

  public constructor() {
    injectOnce('orbit-projection-chart', STYLE);
    this.element = document.createElement('canvas');
    this.element.className = 'orbit-projection-chart';
    const ctx = this.element.getContext('2d');
    if (!ctx) throw new Error('2D canvas context is not available');
    this.ctx = ctx;
  }

  public dispose(): void {
  }

  public plotPixelSize(): { width: number; height: number } | null {
    return this.lastPlotWidth > 0 && this.lastPlotHeight > 0
      ? { width: this.lastPlotWidth, height: this.lastPlotHeight } : null;
  }

  public resetView(): void {
    this.centerLon = 0;
    this.centerLat = 0;
    this.zoomLevel = ZOOM_MIN;
  }

  // ドラッグ移動量 [px] を表示範囲(度)へ換算して中心を動かす。
  public pan(dxPx: number, dyPx: number): void {
    if (this.lastPlotWidth <= 0 || this.lastPlotHeight <= 0) return;
    const { lonSpan, latSpan } = this.spanDeg();
    this.centerLon -= (dxPx / this.lastPlotWidth) * lonSpan;
    this.centerLat += (dyPx / this.lastPlotHeight) * latSpan;
    this.clampCenter();
  }

  // ホイール/ピンチのデルタでズームする。縦横は常に同倍率。
  public zoom(wheelDelta: number): void {
    this.zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomLevel * Math.exp(wheelDelta)));
    this.clampCenter();
  }

  private spanDeg(): { lonSpan: number; latSpan: number } {
    return { lonSpan: 360 / this.zoomLevel, latSpan: 180 / this.zoomLevel };
  }

  // 表示範囲が全球からはみ出さないよう中心を寄せて止める。
  private clampCenter(): void {
    const { lonSpan, latSpan } = this.spanDeg();
    const halfLon = lonSpan / 2;
    const halfLat = latSpan / 2;
    this.centerLon = lonSpan >= 360 ? 0 : Math.max(-180 + halfLon, Math.min(180 - halfLon, this.centerLon));
    this.centerLat = latSpan >= 180 ? 0 : Math.max(-90 + halfLat, Math.min(90 - halfLat, this.centerLat));
  }

  private currentWindow(): Window {
    const { lonSpan, latSpan } = this.spanDeg();
    return {
      lonMin: this.centerLon - lonSpan / 2,
      lonMax: this.centerLon + lonSpan / 2,
      latMin: this.centerLat - latSpan / 2,
      latMax: this.centerLat + latSpan / 2,
    };
  }

  // 背景(テクスチャ or 空メッセージ)→グリッド→各系列の折れ線・現在位置マークの順に描く。
  public draw(spec: ProjectionChartSpec): void {
    resizeCanvasBackingStore(this.element, this.ctx, this.backing);
    const ctx = this.ctx;
    const cssWidth = this.backing.cssWidth;
    const cssHeight = this.backing.cssHeight;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    if (cssWidth <= 0 || cssHeight <= 0) return;

    const plotLeft = PADDING_LEFT;
    const plotTop = PADDING_TOP;
    const plotWidth = cssWidth - PADDING_LEFT - PADDING_RIGHT;
    const plotHeight = cssHeight - PADDING_TOP - PADDING_BOTTOM;
    this.lastPlotWidth = plotWidth;
    this.lastPlotHeight = plotHeight;
    if (plotWidth <= 0 || plotHeight <= 0) return;
    const win = this.currentWindow();

    ctx.font = `${FONT_XXS} ${FONT_FAMILY}`;
    ctx.textBaseline = 'middle';

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotLeft, plotTop, plotWidth, plotHeight);
    ctx.clip();
    if (spec.textureImage) this.drawTexture(spec.textureImage, win, plotLeft, plotTop, plotWidth, plotHeight);
    else {
      ctx.fillStyle = TEXT_DIM;
      ctx.textAlign = 'center';
      ctx.fillText(spec.emptyMessage ?? '', plotLeft + plotWidth / 2, plotTop + plotHeight / 2);
    }
    this.drawGridLines(win, plotLeft, plotTop, plotWidth, plotHeight);
    for (const series of spec.series) this.drawSeries(series, win, plotLeft, plotTop, plotWidth, plotHeight);
    ctx.restore();

    this.drawGridLabels(win, plotLeft, plotTop, plotWidth, plotHeight);
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
  }

  private toPx(
    lonDeg: number, latDeg: number, win: Window,
    plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number,
  ): { x: number; y: number } {
    return {
      x: plotLeft + ((lonDeg - win.lonMin) / (win.lonMax - win.lonMin)) * plotWidth,
      y: plotTop + ((win.latMax - latDeg) / (win.latMax - win.latMin)) * plotHeight,
    };
  }

  // 表示範囲に対応するテクスチャの矩形だけを切り出して拡大表示する。
  private drawTexture(
    image: HTMLImageElement, win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number,
  ): void {
    const sx = ((win.lonMin + 180) / 360) * image.naturalWidth;
    const sWidth = ((win.lonMax - win.lonMin) / 360) * image.naturalWidth;
    const sy = ((90 - win.latMax) / 180) * image.naturalHeight;
    const sHeight = ((win.latMax - win.latMin) / 180) * image.naturalHeight;
    this.ctx.drawImage(image, sx, sy, sWidth, sHeight, plotLeft, plotTop, plotWidth, plotHeight);
  }

  private drawGridLines(win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += GRID_STEP_DEG) {
      if (lon < win.lonMin || lon > win.lonMax) continue;
      const { x } = this.toPx(lon, 0, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotHeight);
      ctx.stroke();
    }
    for (let lat = -90; lat <= 90; lat += GRID_STEP_DEG) {
      if (lat < win.latMin || lat > win.latMax) continue;
      const { y } = this.toPx(0, lat, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
    }
  }

  private drawGridLabels(win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = TEXT_DIM;
    ctx.textAlign = 'center';
    for (let lon = -180; lon <= 180; lon += GRID_STEP_DEG) {
      if (lon < win.lonMin || lon > win.lonMax) continue;
      const { x } = this.toPx(lon, 0, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.fillText(lonLabel(lon), x, plotTop + plotHeight + 10);
    }
    ctx.textAlign = 'left';
    for (let lat = -90; lat <= 90; lat += GRID_STEP_DEG) {
      if (lat < win.latMin || lat > win.latMax) continue;
      const { y } = this.toPx(0, lat, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.fillText(latLabel(lat), 2, y);
    }
  }

  private drawSeries(
    series: ProjectionSeriesSpec, win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number,
  ): void {
    const toPx = (point: ProjectionPoint): { x: number; y: number } =>
      this.toPx(point.lonDeg, point.latDeg, win, plotLeft, plotTop, plotWidth, plotHeight);
    drawPolylineWithGaps(this.ctx, series.points, toPx, series.color, LINE_WIDTH);

    const { x, y } = toPx(series.current);
    drawPointMarker(this.ctx, x, y, series.currentStyle === 'filled', MARK_RADIUS, MARK_RING_WIDTH);
  }
}
