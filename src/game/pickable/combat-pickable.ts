// 戦闘ビューでの右クリックが、生存中の実体(自艦・敵艦・基地)の3Dモデル表示領域に当たったかを
// 判定する。map-pickable.ts / line-pickable.ts と同じ「画面座標から最も手前の候補を選ぶ」
// 当たり判定だが、対象が MapPickable の固定候補列ではなく DynamicSystem の実体そのものである点が
// 異なる。
import { Base } from '../dynamic/dynamic-entity/base';
import type { CombatTarget } from '../targeter';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { ProjectFn } from '../camera/camera-system';
import { metersPerPixel, type Viewpoint } from '../../math/projection';
import { add, cross, len, norm, scale, sub } from '../../math/vec3';

// 画面上の座標 (clientX, clientY) に視覚的に最も手前でヒットした生存中の実体を返す。
// カメラの視点・画角・実体サイズから画面上の視覚半径を求めてヒット判定し、基地はさらに
// BVH メッシュへのレイキャストで絞り込む。当たらなければ null。
export function pickCombatEntityAtPoint(
  entities: DynamicSystem, view: Viewpoint, project: ProjectFn, clientX: number, clientY: number,
): CombatTarget | null {
  const viewportHeight = window.innerHeight;

  const candidates: { entity: CombatTarget; radius: number }[] = [
    ...entities.players.filter((p) => p.alive).map((p) => ({ entity: p, radius: p.radius || 5 })),
    ...entities.enemies.filter((e) => e.alive).map((e) => ({ entity: e, radius: e.radius || 90 })),
    ...entities.bases.filter((b) => b.alive).map((b) => ({ entity: b, radius: b.radius || 100 })),
  ];

  let bestEntity: CombatTarget | null = null;
  let minDepth = Infinity;

  for (const item of candidates) {
    const entity = item.entity;
    const pos = entity.state.r;
    const proj = project(pos);
    if (!proj.front) continue;

    const dx = clientX - proj.x;
    const dy = clientY - proj.y;
    const distSq = dx * dx + dy * dy;

    // カメラから対象までの視線奥行き距離
    const depth = len(sub(pos, view.position));

    // この距離における 1 ピクセルあたりの実距離 [m/px]
    const mpp = metersPerPixel(view, pos, viewportHeight);

    // 3D モデルの物理半径を画面上のピクセル半径へ投影
    // クリック操作の最小許容値として 12px、実サイズに基づく投影ピクセル半径を適用
    const visualRadiusPx = Math.max(12, item.radius / Math.max(1e-6, mpp));

    if (distSq <= visualRadiusPx * visualRadiusPx) {
      if (entity instanceof Base) {
        // 基地の場合は BVH メッシュRay判定による精緻なヒットテストを実施
        const camFwd = norm(sub(view.lookTarget, view.position));
        const camUp = norm(view.up);
        const camRight = norm(cross(camFwd, camUp));
        const offsetX = (clientX - window.innerWidth / 2) * mpp;
        const offsetY = -(clientY - window.innerHeight / 2) * mpp;
        const rayTarget = add(add(add(view.position, scale(camFwd, depth)), scale(camRight, offsetX)), scale(camUp, offsetY));
        const rayDir = norm(sub(rayTarget, view.position));
        const hit = entity.raycast(view.position, rayDir, depth * 2, 1);
        if (!hit) continue; // 実際のメッシュへの非命中の場合は判定を落とす
      }
      if (depth < minDepth) {
        minDepth = depth;
        bestEntity = entity;
      }
    }
  }

  return bestEntity;
}
