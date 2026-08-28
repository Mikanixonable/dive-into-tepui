// チャート canvas 2D の下回り。devicePixelRatio 対応の backing store 調整、折れ線描画、
// 現在地点/ターゲット点の丸マーク、16:9 表示とパン/ズームのカーソル制御の CSS を持つ。
import { ACCENT, ACCENT_SOFT, TEXT_STRONG } from '../../theme';

export interface BackingStoreState {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

export const CHART_ASPECT_RATIO = '16 / 9';
export const CHART_LINE_WIDTH = 1.5;
export const CHART_MARK_RADIUS = 3;
export const CHART_MARK_RING_WIDTH = 1;

// 16:9 いっぱいに広がる canvas の表示寸法と、'panzoom' クラスが付いているときのカーソル形状
// (待機時は grab、ドラッグ中は grabbing)を定める CSS。className はその canvas 自身の
// 識別クラス名。
export function chartCanvasStyle(className: string): string {
  return `
#hud .${className} { display: block; width: 100%; aspect-ratio: ${CHART_ASPECT_RATIO}; }
#hud .${className}.panzoom { touch-action: none; cursor: grab; }
#hud .${className}.panzoom:active { cursor: grabbing; }
`;
}

// canvas の CSS 上の表示サイズと devicePixelRatio に合わせて backing store の実ピクセル数を
// 更新する。前回から変化がなければ何もしない。state はこの呼び出しの結果で書き換わる。
export function resizeCanvasBackingStore(
  canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, state: BackingStoreState,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  // 前回から変化がなければ何もしない。
  if (cssWidth === state.cssWidth && cssHeight === state.cssHeight && dpr === state.dpr) return;
  state.cssWidth = cssWidth;
  state.cssHeight = cssHeight;
  state.dpr = dpr;
  // backing store の実ピクセル数を dpr 倍にし、以後は CSS ピクセル単位で描画できるよう座標変換を設定する。
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 点列を折れ線として描く。null は「ここで線が切れる」印 —— 直前までの線分を確定させ、
// 次の点から新しい線分として描き直す。
export function drawPolylineWithGaps<T>(
  ctx: CanvasRenderingContext2D,
  points: readonly (T | null)[],
  toPx: (point: T) => { x: number; y: number },
  strokeStyle: string,
  lineWidth: number,
): void {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let penDown = false;
  // null に当たったらペンを上げ(penDown=false)、次の点から新しい線分として置き直す。
  for (const point of points) {
    if (point === null) {
      penDown = false;
      continue;
    }
    const { x, y } = toPx(point);
    if (penDown) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    penDown = true;
  }
  ctx.stroke();
}

// 現在地点/ターゲット位置を示す丸マーク。filled なら塗り丸(自艦などの現在地点)、
// そうでなければ縁だけの丸(ターゲット位置)。
export function drawPointMarker(
  ctx: CanvasRenderingContext2D, x: number, y: number, filled: boolean, radius: number, ringWidth: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  // filled は内部をアクセント色で塗って縁取り、そうでなければ縁だけを描く。
  if (filled) {
    ctx.fillStyle = ACCENT_SOFT;
    ctx.fill();
    ctx.strokeStyle = ACCENT;
  } else {
    ctx.strokeStyle = TEXT_STRONG;
  }
  ctx.lineWidth = ringWidth;
  ctx.stroke();
}
