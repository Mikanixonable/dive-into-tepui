// 戦闘ビューでの右クリックが、生存中の実体(自艦・敵艦・基地)のどれに当たったかを判定する。
// 画面座標から実体の形へ視線を通し、最も手前のものを選ぶ。
import { isCombatTarget, type CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { EntityRoster } from '../dynamic/entity-roster';
import { rayThroughScreen, type Viewpoint } from '../../math/projection';
import { len, sub } from '../../math/vec3';
import type { ProjectFn } from '../../math/projection';
import type { Viewport } from '../../render/viewport';
import type { ModularShip } from '../ship/modular-ship';
import type { ShipModuleInstance } from '../ship/ship-module-instance';

// 中心からこの半径 [px] 以内のクリックは、形を外していても当たったものとして扱う。
// これが無いと、遠方で数ピクセルにしか写らない実体を掴めない。
const GRAB_RADIUS_PX = 12;

// 画面上の座標 (clientX, clientY) に最も手前でヒットした生存中の実体を返す。当たらなければ null。
export function pickCombatEntityAtPoint(
  roster: EntityRoster, view: Viewpoint, project: ProjectFn, clientX: number, clientY: number,
  viewport: Viewport,
): CombatTarget | null {
  const ray = rayThroughScreen(view, clientX, clientY, viewport.width, viewport.height);

  let bestEntity: CombatTarget | null = null;
  let minDepth = Infinity;

  for (const entity of roster.all()) {
    if (!isCombatTarget(entity) || !entity.motion.alive) continue;
    const pos = entity.motion.state.r;
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

// 画面上の座標 (clientX, clientY) を通る視線が、ship のどのモジュールに最も手前で当たるかを返す。
// compound 形状を持たない船体や、どのモジュールにも当たらなければ null。
export function pickShipModuleAtPoint(
  ship: ModularShip, view: Viewpoint, clientX: number, clientY: number, viewport: Viewport,
): ShipModuleInstance | null {
  const ray = rayThroughScreen(view, clientX, clientY, viewport.width, viewport.height);
  const hit = ship.motion.raycastCompound(ray, ship.motion.state.r);
  return hit === null ? null : ship.assembly.module(hit.moduleId);
}
