// 戦闘ビューでの右クリックが、生存中の実体(自艦・敵艦・基地)のどれに当たったかを判定する。
// 画面座標から実体の形へ視線を通し、最も手前のものを選ぶ。
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

    // 視点から対象までの距離。手前かどうかの比較に使う。
    const depth = len(sub(pos, view.position));
    if (depth >= minDepth) continue;

    const dx = clientX - proj.x;
    const dy = clientY - proj.y;
    const nearCenter = dx * dx + dy * dy <= GRAB_RADIUS_PX * GRAB_RADIUS_PX;
    if (!nearCenter && !entity.hitBodyByRay(ray, pos)) continue;

    minDepth = depth;
    bestEntity = entity;
  }

  return bestEntity;
}
