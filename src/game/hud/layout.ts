export interface Point2 {
  x: number;
  y: number;
}

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
