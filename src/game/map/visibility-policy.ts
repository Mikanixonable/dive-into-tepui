// 天体とゲーム内 entity に共通するマップ表示ポリシー。
// category/icon/label/orbit/pickable を各描画・選択系で個別に解釈しないための正本。
// DynamicEntityKind は公開メソッド dynamic(kind) の引数型なので export したままにする。
import {
  ancestorsOf, motionById, sameSystemIds, type CelestialClassLookup,
} from '../celestial/system-membership';
import type { CelestialMotion } from '../../physics/celestial-motion';
import { celestialClassVisible, celestialNameVisible, type MapDisplayToggles } from './display-toggles';
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';
import type { CelestialSystem } from '../celestial/celestial-system';

export type DynamicEntityKind = 'player' | 'ship' | 'ammo' | 'fuel' | 'base';

export type MapVisibility = {
  readonly category: boolean;
  readonly icon: boolean;
  readonly label: boolean;
  readonly orbit: boolean;
  readonly pickable: boolean;
};

const ENTITY_KEYS: Record<DynamicEntityKind, {
  readonly category: keyof MapDisplayToggles;
  readonly name: keyof MapDisplayToggles;
  readonly orbit: keyof MapDisplayToggles;
}> = {
  player: { category: 'playerVisible', name: 'playerName', orbit: 'playerOrbit' },
  ship: { category: 'shipVisible', name: 'shipName', orbit: 'shipOrbit' },
  ammo: { category: 'ammoVisible', name: 'ammoName', orbit: 'ammoOrbit' },
  fuel: { category: 'fuelVisible', name: 'fuelName', orbit: 'fuelOrbit' },
  base: { category: 'baseVisible', name: 'baseName', orbit: 'baseOrbit' },
};

// フォーカス対象が属する惑星系の代表 id(惑星なら自分、衛星なら親惑星)。ラグランジュ点の
// id は所属天体の id へ戻してから引く。天体でない・恒星をフォーカスしているなら null。
function focusSystemOf(celestialSystem: CelestialSystem, focusId: string | undefined): string | null {
  if (focusId === undefined) return null;
  const body = celestialSystem.find(focusId.replace(/-l[1-5]$/, ''));
  if (body === null) return null;
  const motion = body.motion;
  if (motion.kind === 'planet') return motion.id;
  return motion.kind === 'satellite' ? motion.primary?.id ?? null : null;
}

// 恒星、フォーカス中の天体の親・兄弟・子、およびカメラが現在属する系の天体——トグルの
// 状態に関わらず名前が見える id の集合。「距離が近いもの」をズーム距離で判定
// すると操作の途中で行が明滅するので、カメラ位置から求めた重力系のメンバーで代用する。
// focusId が undefined でも、nearbyIds に渡された近傍系は残す。
export function alwaysFullyVisibleIds(
  motions: readonly CelestialMotion[], bodyClass: CelestialClassLookup, focusId: string | undefined,
  nearbyIds: Iterable<string> = [],
  toggles?: MapDisplayToggles,
): ReadonlySet<string> {
  const byId = motionById(motions);
  const ids = new Set<string>();
  for (const m of motions) {
    if (m.kind === 'star') ids.add(m.id);
  }

  // nearbyIds は systemMembersAt() など、呼び出し側がカメラ位置から求めた系の集合。
  // 未登録の重力源が混ざっても、ここは天体ラベルの集合なので無視する。
  for (const id of nearbyIds) {
    if (byId.has(id) && (toggles === undefined || celestialClassVisible(bodyClass(id), toggles))) {
      ids.add(id);
    }
  }

  if (focusId === undefined) return ids;

  for (const id of ancestorsOf(byId, focusId)) {
    if (toggles === undefined || celestialClassVisible(bodyClass(id), toggles)) ids.add(id);
  }
  // 兄弟は「惑星系の中の兄弟」に限る。恒星の子はすべて互いに兄弟なので、そこまで含めると
  // 惑星にフォーカスしただけで全太陽周回天体が出てしまう(惑星どうしの表示は planetOrbit/
  // planetName トグルが別途受け持つ)。
  const focusParent = byId.get(focusId)?.primary ?? null;
  const siblingsMatter = focusParent !== null && focusParent.kind !== 'star';
  for (const id of sameSystemIds(motions, focusId)) {
    // focusId 自身は未登録(生存中の重力天体)でもありうるので、親を引く前に弾く。
    if ((siblingsMatter || id === focusId || (byId.get(id)?.primary?.id ?? null) === focusId)
      && (toggles === undefined || celestialClassVisible(bodyClass(id), toggles))) {
      ids.add(id);
    }
  }
  return ids;
}

function noVisibility(): MapVisibility {
  return { category: false, icon: false, label: false, orbit: false, pickable: false };
}

export class MapVisibilityPolicy {
  private readonly alwaysVisible: ReadonlySet<string>;
  private readonly nearby: ReadonlySet<string>;
  // policy の入力(toggles/focus/nearby)はインスタンス生成後に変わらない。判定結果を
  // id/kind ごとに保持し、同じフレームで body()/entity() を何度呼んでもオブジェクトと
  // 条件分岐を作り直さない。呼び出し側がトグルを変える場合は新しい policy を作る。
  private readonly bodyResults = new Map<string, MapVisibility>();
  private readonly entityResults = new Map<string, MapVisibility>();

  constructor(
    private readonly celestialSystem: CelestialSystem,
    private readonly toggles: MapDisplayToggles,
    private readonly focusId?: string,
    nearbyIds: Iterable<string> = [],
  ) {
    this.alwaysVisible = alwaysFullyVisibleIds(
      celestialSystem.celestialMotions, (id) => celestialSystem.find(id)?.bodyClass ?? 'planet',
      focusId, nearbyIds, toggles);
    this.nearby = new Set(nearbyIds);
  }

  body(id: string): MapVisibility {
    const cached = this.bodyResults.get(id);
    if (cached !== undefined) return cached;

    const result = this.computeBody(id);
    this.bodyResults.set(id, result);
    return result;
  }

  private computeBody(id: string): MapVisibility {
    if (/-l[1-5]$/.test(id)) {
      const category = this.toggles.lagrangeVisible;
      const shown = category && this.toggles.lagrangeName;
      return { category, icon: shown, label: shown, orbit: false, pickable: shown };
    }
    const body = this.celestialSystem.find(id);
    if (body === null) return noVisibility();

    const cls = body.bodyClass;
    const category = celestialClassVisible(cls, this.toggles);
    if (!category) return noVisibility();
    const forced = this.alwaysVisible.has(id);
    const shown = forced || celestialNameVisible(cls, this.toggles);
    const orbit = this.orbitForBody(id, cls);
    return { category, icon: shown, label: shown, orbit, pickable: shown };
  }

  entity(kind: DynamicEntityKind, isActivePlayer = false): MapVisibility {
    const key = `${kind}:${isActivePlayer ? 'active' : 'inactive'}`;
    const cached = this.entityResults.get(key);
    if (cached !== undefined) return cached;

    const result = this.computeEntity(kind, isActivePlayer);
    this.entityResults.set(key, result);
    return result;
  }

  private computeEntity(kind: DynamicEntityKind, isActivePlayer: boolean): MapVisibility {
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

  private orbitForBody(id: string, cls: CelestialClass): boolean {
    switch (cls) {
      case 'planet': return this.toggles.planetOrbit;
      case 'dwarf': return this.toggles.dwarfOrbit;
      case 'smallBody': return this.toggles.smallBodyOrbit;
      case 'satellite': {
        const planetId = this.celestialSystem.entityOf(id).motion.primary?.id ?? null;
        if (planetId === null) return false;
        return this.toggles.satelliteOrbit
          && (planetId === 'earth' || focusSystemOf(this.celestialSystem, this.focusId) === planetId
            || this.nearby.has(id));
      }
      default: return false;
    }
  }
}
