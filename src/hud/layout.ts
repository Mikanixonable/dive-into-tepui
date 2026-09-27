// 画面座標でのオーバーレイ配置。要求座標をビューポート内へクランプする幾何計算と、
// DOM 要素への反映をまとめる。

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

// 要求座標をビューポート内へクランプして、要素をその位置へ置く。実寸はここで測る。
export function placeOverlayAt(el: HTMLElement, requested: Point2): void {
  const pos = clampOverlayPosition(
    requested,
    el.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
  );
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
}
