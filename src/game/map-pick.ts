// マップ上で右クリックの被選択対象になりうるものの共通形と、画面上で最も近い候補を選ぶ処理。
import { Vec3 } from '../physics/vec3';
import type { ProjectFn } from './camera/camera-system';

export type MapPickKind = 'body' | 'ship' | 'apsis' | 'relnode' | 'creativeShip';

export interface MapPickable {
  readonly id: string;
  readonly name: string;
  readonly pos: Vec3;
  readonly kind: MapPickKind;
}

// items を project で画面へ射影し、(x, y) から半径 radiusPxSq [px^2] 以内で最も近いものを返す。
// 圏外なら null。
export function pickNearest<T extends MapPickable>(
  items: readonly T[],
  x: number,
  y: number,
  project: ProjectFn,
  radiusPxSq: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = radiusPxSq;
  for (const item of items) {
    const p = project(item.pos);
    if (!p.front) continue;
    const dx = p.x - x;
    const dy = p.y - y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = item;
    }
  }
  return best;
}
