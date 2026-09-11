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
