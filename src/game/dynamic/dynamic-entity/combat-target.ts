// 戦闘の対象になれる個体(自艦・敵艦・基地)が答えるもの。世界に実体を持ち(DynamicEntity)、
// マップから選べ(ObjectPickable)、マップの表示トグルを持つ種別に属し、自分の画面マーカーを
// 組めるものだけが実装できる。
import type { Vec3 } from '../../../math/vec3';
import type { View } from '../../view/view';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { ObjectPickable } from '../../pickable/object-pickable';
import type { DynamicEntityKind } from './entity-kind';
import type { DynamicEntity } from './dynamic-entity';

export interface CombatTarget extends DynamicEntity, ObjectPickable {
  // 戦闘対象は必ずマップの表示トグルを持つ種別に属する。
  readonly mapKind: DynamicEntityKind;
  // 削れる耐久値を持たない種別は null。
  readonly hp: number | null;
  readonly maxHp: number | null;

  // 画面マーカー・一覧に出す項目。pos/vel にはメッシュと同じ表示時刻の状態を渡すこと。
  // isActive はこの個体が操作対象かどうか(マップ上の塗り分けに使う)。
  markerItem(viewerPos: Vec3, pos: Vec3, vel: Vec3, view: View, isActive: boolean): GroupedMarkerItem;
}

// この個体が戦闘対象になりうるか。顔ぶれから戦闘対象だけを絞るときに使う。
export function isCombatTarget(entity: DynamicEntity): entity is CombatTarget {
  return entity.combatTarget;
}

// id で名指しされた戦闘対象。生死は問わない。見つからなければ null。
export function combatTargetById(
  entities: readonly DynamicEntity[], id: string,
): CombatTarget | null {
  return entities.find((e): e is CombatTarget => e.id === id && e.combatTarget) ?? null;
}

// id で名指しされた、生存中の戦闘対象。天体・ラグランジュ点は実体を持たないため対象外。
export function aliveCombatTarget(
  entities: readonly DynamicEntity[], id: string,
): CombatTarget | null {
  const target = combatTargetById(entities, id);
  return target?.alive ? target : null;
}
