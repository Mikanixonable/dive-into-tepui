// 画面座標に関する DOM/カメラ非依存の幾何計算。オーバーレイの再配置に使う。

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

// requested 位置に overlay を置いたとき viewport をはみ出さないよう、margin ぶん内側へ収めた座標を返す。
export function clampOverlayPosition(
  requested: Point2,
  overlay: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 6,
): Point2 {
  return {
    x: Math.max(margin, Math.min(requested.x, viewport.width - overlay.width - margin)),
    y: Math.max(margin, Math.min(requested.y, viewport.height - overlay.height - margin)),
  };
}
