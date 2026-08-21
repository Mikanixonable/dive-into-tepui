// 天体とゲーム内 entity に共通するマップ表示ポリシー。
// category/icon/label/orbit/pickable を各描画・選択系で個別に解釈しないための正本。
import type { AttractorId } from '../../physics/attractor';
import type { CelestialRegistry } from '../../physics/solar-system';
import {
  alwaysFullyVisibleIds,
  bodyClassVisible,
  bodyNameVisible,
  type BodyClassToggles,
} from './body-visibility';
import { bodyClassOf } from './body-class';
import { bodyDef } from '../../physics/solar-system';

export type MapEntityKind = 'player' | 'ship' | 'ammo' | 'base';

export type MapVisibility = {
  readonly category: boolean;
  readonly icon: boolean;
  readonly label: boolean;
  readonly orbit: boolean;
  readonly pickable: boolean;
};

const ENTITY_KEYS: Record<MapEntityKind, {
  readonly category: keyof BodyClassToggles;
  readonly name: keyof BodyClassToggles;
  readonly orbit: keyof BodyClassToggles;
}> = {
  player: { category: 'playerVisible', name: 'playerName', orbit: 'playerOrbit' },
  ship: { category: 'shipVisible', name: 'shipName', orbit: 'shipOrbit' },
  ammo: { category: 'ammoVisible', name: 'ammoName', orbit: 'ammoOrbit' },
  base: { category: 'baseVisible', name: 'baseName', orbit: 'baseOrbit' },
};

function focusSystemOf(registry: CelestialRegistry, focusId: AttractorId | undefined): AttractorId | null {
  if (focusId === undefined) return null;
  const bodyId = focusId.replace(/-l[1-5]$/, '');
  if (!(bodyId in registry)) return null;
  const def = bodyDef(registry, bodyId);
  if (def.kind === 'planet') return def.id;
  return def.kind === 'satellite' ? def.planet : null;
}

function noVisibility(): MapVisibility {
  return { category: false, icon: false, label: false, orbit: false, pickable: false };
}

export class MapVisibilityPolicy {
  private readonly alwaysVisible: ReadonlySet<AttractorId>;
  private readonly nearby: ReadonlySet<AttractorId>;
  // policy の入力(toggles/focus/nearby)はインスタンス生成後に変わらない。判定結果を
  // id/kind ごとに保持し、同じフレームで body()/entity() を何度呼んでもオブジェクトと
  // 条件分岐を作り直さない。呼び出し側がトグルを変える場合は新しい policy を作る。
  private readonly bodyResults = new Map<AttractorId, MapVisibility>();
  private readonly entityResults = new Map<string, MapVisibility>();

  constructor(
    private readonly registry: CelestialRegistry,
    private readonly toggles: BodyClassToggles,
    private readonly focusId?: AttractorId,
    nearbyIds: Iterable<AttractorId> = [],
  ) {
    this.alwaysVisible = alwaysFullyVisibleIds(registry, focusId, nearbyIds, toggles);
    this.nearby = new Set(nearbyIds);
  }

  body(id: AttractorId): MapVisibility {
    const cached = this.bodyResults.get(id);
    if (cached !== undefined) return cached;

    const result = this.computeBody(id);
    this.bodyResults.set(id, result);
    return result;
  }

  private computeBody(id: AttractorId): MapVisibility {
    if (/-l[1-5]$/.test(id)) {
      const category = this.toggles.lagrangeVisible;
      const shown = category && this.toggles.lagrangeName;
      return { category, icon: shown, label: shown, orbit: false, pickable: shown };
    }
    if (this.registry[id] === undefined) return noVisibility();

    const cls = bodyClassOf(this.registry, id);
    const category = bodyClassVisible(cls, this.toggles);
    if (!category) return noVisibility();
    const forced = this.alwaysVisible.has(id);
    const shown = forced || bodyNameVisible(this.registry, this.toggles, id);
    const orbit = this.orbitForBody(id, cls);
    return { category, icon: shown, label: shown, orbit, pickable: shown };
  }

  entity(kind: MapEntityKind, isActivePlayer = false): MapVisibility {
    const key = `${kind}:${isActivePlayer ? 'active' : 'inactive'}`;
    const cached = this.entityResults.get(key);
    if (cached !== undefined) return cached;

    const result = this.computeEntity(kind, isActivePlayer);
    this.entityResults.set(key, result);
    return result;
  }

  private computeEntity(kind: MapEntityKind, isActivePlayer: boolean): MapVisibility {
    const keys = ENTITY_KEYS[kind];
    const categoryToggle = this.toggles[keys.category];
    // 操作対象の自艦は、カテゴリを閉じても現在位置を失わないように残す。ただし
    // 艦名/軌道線は名前トグルに従うので、例外が表示設定を無効化しない。
    const category = categoryToggle || (kind === 'player' && isActivePlayer);
    if (!category) return noVisibility();
    const nameToggle = Boolean(this.toggles[keys.name]);
    const icon = kind === 'player' && isActivePlayer ? true : nameToggle;
    const label = nameToggle;
    const orbit = Boolean(this.toggles[keys.orbit]) && category;
    return { category, icon, label, orbit, pickable: icon || label };
  }

  private orbitForBody(id: AttractorId, cls: ReturnType<typeof bodyClassOf>): boolean {
    switch (cls) {
      case 'planet': return this.toggles.planetOrbit;
      case 'dwarf': return this.toggles.dwarfOrbit;
      case 'smallBody': return this.toggles.smallBodyOrbit;
      case 'satellite': {
        const def = bodyDef(this.registry, id);
        if (def.kind !== 'satellite') return false;
        return this.toggles.satelliteOrbit
          && (def.planet === 'earth' || focusSystemOf(this.registry, this.focusId) === def.planet
            || this.nearby.has(id));
      }
      default: return false;
    }
  }
}
