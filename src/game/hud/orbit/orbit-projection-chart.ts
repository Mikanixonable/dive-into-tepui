// 投影タブの描き手。円筒図法テクスチャを背景に、経緯度グリッド・複数系統の軌跡・現在位置を
// canvas 2D へ描く。表示範囲(中心経緯度・ズーム)を自分で持ち、pan/zoom/resetView で操作する。
import { EDGE, FONT_FAMILY, FONT_XXS, TEXT_DIM } from '../../theme';
import { injectOnce } from '../widgets/inject-style';
import {
  CHART_LINE_WIDTH, CHART_MARK_RADIUS, CHART_MARK_RING_WIDTH, chartCanvasStyle,
  drawPointMarker, drawPolylineWithGaps, resizeCanvasBackingStore, type BackingStoreState,
} from './chart-canvas';

interface ProjectionPoint { readonly lonDeg: number; readonly latDeg: number }

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

const PADDING_LEFT = 30;
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 20;
const GRID_STEP_DEG = 30;
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

const STYLE = chartCanvasStyle('orbit-projection-chart');

// 経度グリッドのラベル表記(東経 E / 西経 W、±180° は 180° に統一)。
function lonLabel(deg: number): string {
  if (deg === -180 || deg === 180) return '180°';
  return deg === 0 ? '0°' : `${Math.abs(deg)}°${deg > 0 ? 'E' : 'W'}`;
}

// 緯度グリッドのラベル表記(北緯 N / 南緯 S)。
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

  // canvas 要素を作り、2D コンテキストを確保する。
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

  // 直近の draw() が描いたプロット領域のピクセル寸法。まだ描いていない/寸法0なら null
  // ——呼び出し側がドラッグ移動量を表示範囲の度数へ換算する変換係数として使う。
  public plotPixelSize(): { width: number; height: number } | null {
    return this.lastPlotWidth > 0 && this.lastPlotHeight > 0
      ? { width: this.lastPlotWidth, height: this.lastPlotHeight } : null;
  }

  // 表示範囲を全球・最大縮小(中心経度0・緯度0)へ戻す。
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

  // 現在のズーム倍率での経度・緯度スパン [deg]。
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

  // 中心経緯度・ズーム倍率から、現在プロットへ映している経緯度の範囲を求める。
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

    // プロット領域の寸法を確定し、pan/zoom が px→度の換算に使う値として保持する。
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

    // 背景・グリッド線・系列の折れ線はプロット領域内にクリップして描く。
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

    // グリッドのラベルと外枠はクリップの外(プロット領域の余白)に描く。
    this.drawGridLabels(win, plotLeft, plotTop, plotWidth, plotHeight);
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
  }

  // 経緯度(lonDeg, latDeg)を、表示範囲 win に対するプロット領域内のピクセル座標へ写す。
  // 経度は左から右、緯度は上(latMax)から下(latMin)へ向かって増えるので、y だけ向きを反転する。
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

  // 表示範囲 win に入る経度・緯度 30 度おきの縦横グリッド線を描く。
  private drawGridLines(win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = EDGE;
    ctx.lineWidth = 1;
    // 経度線(縦線)。
    for (let lon = -180; lon <= 180; lon += GRID_STEP_DEG) {
      if (lon < win.lonMin || lon > win.lonMax) continue;
      const { x } = this.toPx(lon, 0, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotHeight);
      ctx.stroke();
    }
    // 緯度線(横線)。
    for (let lat = -90; lat <= 90; lat += GRID_STEP_DEG) {
      if (lat < win.latMin || lat > win.latMax) continue;
      const { y } = this.toPx(0, lat, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
    }
  }

  // drawGridLines の各線に添える経度・緯度のラベル。
  private drawGridLabels(win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = TEXT_DIM;
    // 経度ラベルはプロット下端に沿って並べる。
    ctx.textAlign = 'center';
    for (let lon = -180; lon <= 180; lon += GRID_STEP_DEG) {
      if (lon < win.lonMin || lon > win.lonMax) continue;
      const { x } = this.toPx(lon, 0, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.fillText(lonLabel(lon), x, plotTop + plotHeight + 10);
    }
    // 緯度ラベルはプロット左端に沿って並べる。
    ctx.textAlign = 'left';
    for (let lat = -90; lat <= 90; lat += GRID_STEP_DEG) {
      if (lat < win.latMin || lat > win.latMax) continue;
      const { y } = this.toPx(0, lat, win, plotLeft, plotTop, plotWidth, plotHeight);
      ctx.fillText(latLabel(lat), 2, y);
    }
  }

  // 1系列ぶんの軌跡(折れ線)と現在位置の丸マークを描く。
  private drawSeries(
    series: ProjectionSeriesSpec, win: Window, plotLeft: number, plotTop: number, plotWidth: number, plotHeight: number,
  ): void {
    const toPx = (point: ProjectionPoint): { x: number; y: number } =>
      this.toPx(point.lonDeg, point.latDeg, win, plotLeft, plotTop, plotWidth, plotHeight);
    drawPolylineWithGaps(this.ctx, series.points, toPx, series.color, CHART_LINE_WIDTH);

    const { x, y } = toPx(series.current);
    drawPointMarker(this.ctx, x, y, series.currentStyle === 'filled', CHART_MARK_RADIUS, CHART_MARK_RING_WIDTH);
  }
}
