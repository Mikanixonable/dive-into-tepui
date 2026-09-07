// 右クリック・一覧・選択ウィジェットから選べる物体の契約(面ごとの契約を1つへ束ねたもの)と、
// 画面上で最も近い候補・視線が当たった候補を選ぶ処理。
import { lenSq, sub } from '../../math/vec3';
import type { Ray } from '../../math/ray';
import type { Projected, ProjectFn } from '../../math/projection';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { InspectedObject } from './inspected-object';
import type { ListedObject } from './listed-object';
import type { MapPickable } from './map-pickable';
import type { PickCandidate } from './pick-candidate';

export interface ObjectPickable extends ListedObject, InspectedObject, MapPickable {}

// この個体が被選択物として公開されるか。顔ぶれから被選択物だけを絞るときに使う。
export function isObjectPickable(entity: DynamicEntity): entity is DynamicEntity & ObjectPickable {
  return entity.pickable;
}

// items を screenPosOf で画面へ射影し、(x, y) から半径 radiusPxSq [px^2] 以内で最も近いものを
// 返す。null を返す項目と視点の背後の項目は候補から外れる。圏外なら null。
export function pickNearest<T>(
  items: readonly T[],
  screenPosOf: (item: T) => Projected | null,
  x: number,
  y: number,
  radiusPxSq: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = radiusPxSq;
  for (const item of items) {
    const p = screenPosOf(item);
    if (p === null || !p.front) continue;
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

// 表示時刻のマーカー位置を画面へ射影する。位置が求まらないフレームは null。
export function projectMarker(
  item: PickCandidate, displayTime: number, project: ProjectFn,
): Projected | null {
  const pos = item.posAt(displayTime);
  return pos === null ? null : project(pos);
}

// 視線が本体に当たった候補のうち、視点(= 視線の始点)にもっとも近いものを返す。当たらなければ
// null。位置が求まらない候補は本体判定に掛けない。
export function pickFrontmostBody<T extends MapPickable>(
  items: readonly T[], ray: Ray, displayTime: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = Infinity;
  for (const item of items) {
    const pos = item.posAt(displayTime);
    if (pos === null) continue;
    const distSq = lenSq(sub(pos, ray.origin));
    if (distSq >= bestDistSq || !item.hitBodyByRay(ray, pos)) continue;
    bestDistSq = distSq;
    best = item;
  }
  return best;
}
