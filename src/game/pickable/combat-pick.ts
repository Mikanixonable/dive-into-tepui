// 戦闘ビューでの右クリックが、生存中の実体(自艦・敵艦・基地)のどれに当たったかを判定する。
// map-pickable.ts / line-pickable.ts と同じ「画面座標から候補を選ぶ」当たり判定だが、対象が
// マップの候補列ではなく DynamicSystem の実体そのもので、画面上のマーカー位置ではなく実体の
// 形へ視線を通し、最も手前のものを選ぶ点が異なる。
import type { CombatTarget } from '../targeter';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { ProjectFn } from '../camera/camera-system';
import { rayThroughScreen, type Viewpoint } from '../../math/projection';
import { len, sub } from '../../math/vec3';

// 中心からこの半径 [px] 以内のクリックは、形を外していても当たったものとして扱う。
// これが無いと、遠方で数ピクセルにしか写らない実体を掴めない。
const GRAB_RADIUS_PX = 12;

// 画面上の座標 (clientX, clientY) に最も手前でヒットした生存中の実体を返す。当たらなければ null。
export function pickCombatEntityAtPoint(
  entities: DynamicSystem, view: Viewpoint, project: ProjectFn, clientX: number, clientY: number,
): CombatTarget | null {
  const ray = rayThroughScreen(view, clientX, clientY, window.innerWidth, window.innerHeight);

  let bestEntity: CombatTarget | null = null;
  let minDepth = Infinity;

  for (const entity of entities.getCombatTargets(null)) {
    if (!entity.alive) continue;
    const pos = entity.state.r;
    const proj = project(pos);
    if (!proj.front) continue;

    // 視点から対象までの距離。手前かどうかの比較にも、視線の探索距離にも使う。
    const depth = len(sub(pos, view.position));
    if (depth >= minDepth) continue;

    const dx = clientX - proj.x;
    const dy = clientY - proj.y;
    const nearCenter = dx * dx + dy * dy <= GRAB_RADIUS_PX * GRAB_RADIUS_PX;
    if (!nearCenter && !entity.hitByRay(ray.origin, ray.dir, depth * 2)) continue;

    minDepth = depth;
    bestEntity = entity;
  }

  return bestEntity;
}
