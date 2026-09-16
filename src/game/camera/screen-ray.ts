import { rayThroughScreen, type Viewpoint } from '../../math/projection';
import type { Ray } from '../../math/ray';
import type { Viewport } from '../../render/viewport';

// camera update 後の Viewpoint と同じ CSS pixel viewport から world ray を組む。
export function screenRay(viewpoint: Viewpoint, viewport: Viewport, clientX: number, clientY: number): Ray {
  return rayThroughScreen(viewpoint, clientX, clientY, viewport.width, viewport.height);
}
