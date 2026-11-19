// そのフレームの描画先の寸法。投影・尺度・レンダラの解像度が同じ1つの値を読む。
export interface Viewport {
  readonly width: number; // CSS ピクセル
  readonly height: number; // CSS ピクセル
  readonly pixelRatio: number; // devicePixelRatio
}

// ブラウザの表示領域を、このフレームのビューポートとして読む。
export function browserViewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    pixelRatio: window.devicePixelRatio,
  };
}

// レンダラへ渡す実効ピクセル比の上限。devicePixelRatio の大きい端末でも、描画画素数は
// 解像度倍率 100% でこの倍率までに抑える。
const MAX_PIXEL_RATIO = 2;

// レンダラへ渡す実効ピクセル比。ビューポートの devicePixelRatio へ上限を掛け、
// 描画品質の解像度倍率を掛ける。
export function effectivePixelRatio(viewport: Viewport, resolutionScale: number): number {
  return Math.min(viewport.pixelRatio, MAX_PIXEL_RATIO) * resolutionScale;
}
