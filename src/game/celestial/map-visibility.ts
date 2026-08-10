// 天体とゲーム内 entity に共通するマップ表示ポリシー。
// category/icon/label/orbit/pickable を各描画・選択系で個別に解釈しないための正本。
import type { AttractorId } from '../../physics/attractor';
import type { CelestialRegistry } from '../../physics/solar-system';
import {
  alwaysFullyVisibleIds,
  bodyClassVisible,
  bodyIconLabel,
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
  readonly icon: keyof BodyClassToggles;
  readonly label: keyof BodyClassToggles;
  readonly orbit: keyof BodyClassToggles;
}> = {
  player: { category: 'playerVisible', icon: 'playerIcon', label: 'playerLabel', orbit: 'playerOrbit' },
  ship: { category: 'shipVisible', icon: 'shipIcon', label: 'shipLabel', orbit: 'shipOrbit' },
  ammo: { category: 'ammoVisible', icon: 'ammoIcon', label: 'ammoLabel', orbit: 'ammoOrbit' },
  base: { category: 'baseVisible', icon: 'baseIcon', label: 'baseLabel', orbit: 'baseOrbit' },
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
    if (/-l[1-5]$/.test(id)) {
      const category = this.toggles.lagrangeVisible;
      const icon = category && this.toggles.lagrangeIcon;
      const label = category && this.toggles.lagrangeLabel;
      return { category, icon, label, orbit: false, pickable: category && (icon || label) };
    }
    if (this.registry[id] === undefined) return noVisibility();

    const cls = bodyClassOf(this.registry, id);
    const category = bodyClassVisible(cls, this.toggles);
    if (!category) return noVisibility();
    const forced = this.alwaysVisible.has(id);
    const classDisplay = bodyIconLabel(this.registry, this.toggles, id);
    const icon = forced || classDisplay.icon;
    const label = forced || classDisplay.label;
    const orbit = this.orbitForBody(id, cls);
    return { category, icon, label, orbit, pickable: icon || label };
  }

  entity(kind: MapEntityKind, isActivePlayer = false): MapVisibility {
    const keys = ENTITY_KEYS[kind];
    const categoryToggle = this.toggles[keys.category];
    // 操作対象の自艦は、カテゴリを閉じても現在位置を失わないように残す。ただし
    // ラベル/軌道線は個別トグルに従うので、例外が表示設定を無効化しない。
    const category = categoryToggle || (kind === 'player' && isActivePlayer);
    if (!category) return noVisibility();
    const icon = kind === 'player' && isActivePlayer ? true : Boolean(this.toggles[keys.icon]);
    const label = Boolean(this.toggles[keys.label]);
    const orbit = Boolean(this.toggles[keys.orbit]) && categoryToggle;
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
