// 戦闘の対象になれる個体(自艦・敵艦・基地)が提供する共通インターフェース。
import type { Vec3 } from '../../../math/vec3';
import type { ViewMode } from '../../view/view-mode';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { DynamicEntityKind } from './entity-kind';
import type { DynamicEntity } from './dynamic-entity';

export interface CombatTarget extends DynamicEntity {
  // 戦闘対象は必ずマップの表示トグルを持つ種別に属する。
  readonly mapKind: DynamicEntityKind;
  // 削れる耐久値を持たない種別は null。
  readonly hp: number | null;
  readonly maxHp: number | null;

  // 画面マーカー・一覧に出す項目。pos/vel にはメッシュと同じ表示時刻の状態を渡すこと。
  // viewerPos は視点の位置で、視点が居なければ null — そのときはどの個体も視点から等しく遠く、
  // 距離で決まる範囲の外にあるものとして組む。
  // isActive はこの個体が操作対象かどうか。
  markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3, view: ViewMode, isActive: boolean): GroupedMarkerItem;
}

// entity を戦闘対象へ絞り込む型ガード。
export function isCombatTarget(entity: DynamicEntity): entity is CombatTarget {
  return entity.combatTarget;
}

// 指定された ID の戦闘対象。生死は問わない。見つからなければ null。
export function combatTargetById(
  entities: readonly DynamicEntity[], id: string,
): CombatTarget | null {
  return entities.find((e): e is CombatTarget => e.id === id && e.combatTarget) ?? null;
}

// 指定された ID の、生存中の戦闘対象。見つからないか死んでいれば null。
export function aliveCombatTarget(
  entities: readonly DynamicEntity[], id: string,
): CombatTarget | null {
  const target = combatTargetById(entities, id);
  return target?.motion.alive ? target : null;
}
