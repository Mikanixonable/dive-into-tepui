// 天体とゲーム内 entity に共通するマップ表示ポリシー。マップへ重ねる記号と軌道線の可否を
// 各描画・選択系で個別に解釈しないための正本。
import {
  celestialClassVisible, celestialNameVisible, mapDisplayCategoryVisible,
  type MapDisplayCategory, type MapDisplayToggles,
} from './display-toggles';
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { isLagrangeId, lagrangeParentId } from '../celestial/lagrange-id';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';

export type MapVisibility = {
  readonly icon: boolean;
  readonly label: boolean;
  readonly orbit: boolean;
  readonly pickable: boolean;
};

// マップ上に記号か軌道線のどちらかで現れるか。
export function appearsOnMap(visibility: MapVisibility): boolean {
  return visibility.icon || visibility.orbit;
}

const ENTITY_KEYS: Record<DynamicEntityKind, {
  readonly category: MapDisplayCategory;
  readonly name: keyof MapDisplayToggles;
  readonly orbit: keyof MapDisplayToggles;
}> = {
  player: { category: 'playerVisible', name: 'playerName', orbit: 'playerOrbit' },
  enemy: { category: 'enemyVisible', name: 'enemyName', orbit: 'enemyOrbit' },
  ammo: { category: 'ammoVisible', name: 'ammoName', orbit: 'ammoOrbit' },
  fuel: { category: 'fuelVisible', name: 'fuelName', orbit: 'fuelOrbit' },
  base: { category: 'baseVisible', name: 'baseName', orbit: 'baseOrbit' },
};

// フォーカス対象が属する惑星系の代表 id(惑星なら自分、衛星なら親惑星)。ラグランジュ点の
// id は所属天体の id へ戻してから引く。天体でない・恒星をフォーカスしているなら null。
function focusSystemOf(celestialBodies: CelestialBodies, focusId: string | undefined): string | null {
  if (focusId === undefined) return null;
  const motion = celestialBodies.findMotion(lagrangeParentId(focusId));
  if (motion === null) return null;
  if (motion.kind === 'planet') return motion.id;
  return motion.kind === 'satellite' ? motion.primary?.id ?? null : null;
}

// 恒星、フォーカス中の天体の親・兄弟・子、およびカメラが現在属する系の天体——トグルの
// 状態に関わらず名前が見える id の集合。「距離が近いもの」をズーム距離で判定
// すると操作の途中で行が明滅するので、カメラ位置から求めた重力系のメンバーで代用する。
export function alwaysFullyVisibleIds(
  celestialBodies: CelestialBodies, focusId: string | undefined,
  nearbyIds: Iterable<string> = [],
  toggles?: MapDisplayToggles,
): ReadonlySet<string> {
  // 未登録の id は 'planet' として扱い、トグルが無ければクラスで絞らない。
  const classVisible = (id: string): boolean => toggles === undefined
    || celestialClassVisible(celestialBodies.bodyClassOf(id) ?? 'planet', toggles);
  const ids = new Set<string>();
  for (const motion of celestialBodies.celestialMotions) {
    if (motion.kind === 'star') ids.add(motion.id);
  }

  // 未登録の重力源が混ざっても、ここは天体ラベルの集合なので無視する。
  for (const id of nearbyIds) {
    if (celestialBodies.has(id) && classVisible(id)) ids.add(id);
  }

  if (focusId === undefined) return ids;

  for (const id of celestialBodies.ancestorsOf(focusId)) {
    if (classVisible(id)) ids.add(id);
  }
  // 兄弟は「惑星系の中の兄弟」に限る。恒星の子はすべて互いに兄弟なので、そこまで含めると
  // 惑星にフォーカスしただけで全太陽周回天体が出てしまう。
  const focusParent = celestialBodies.findMotion(focusId)?.primary ?? null;
  const siblingsMatter = focusParent !== null && focusParent.kind !== 'star';
  for (const id of celestialBodies.sameSystemIds(focusId)) {
    // focusId 自身は未登録(生存中の重力天体)でもありうるので、親の参照前に除外する。
    if ((siblingsMatter || id === focusId
      || (celestialBodies.findMotion(id)?.primary?.id ?? null) === focusId) && classVisible(id)) {
      ids.add(id);
    }
  }
  return ids;
}

// 表示トグルを持たない対象(軌道上の点マーカー、弾・薬莢・破片)の判定。
export const MARKER_VISIBILITY: MapVisibility = {
  icon: true, label: true, orbit: false, pickable: true,
};

// マップへ何も重ねない判定。
function noVisibility(): MapVisibility {
  return { icon: false, label: false, orbit: false, pickable: false };
}

export class MapVisibilityPolicy {
  private readonly alwaysVisible: ReadonlySet<string>;
  private readonly nearby: ReadonlySet<string>;
  // 入力(toggles/focus/nearby)は生成後に変わらないので、判定結果を id/kind ごとに保持する。
  // トグルを変えるときは、新しい policy を作る。
  private readonly bodyResults = new Map<string, MapVisibility>();
  private readonly entityResults = new Map<string, MapVisibility>();

  // focusId は注視中の対象、nearbyIds は近傍として常時表示へ格上げする天体の id。どちらも
  // 省くと格上げが効かず、トグルだけで決まる。
  constructor(
    private readonly celestialBodies: CelestialBodies,
    private readonly toggles: MapDisplayToggles,
    private readonly focusId?: string,
    nearbyIds: Iterable<string> = [],
  ) {
    this.alwaysVisible = alwaysFullyVisibleIds(celestialBodies, focusId, nearbyIds, toggles);
    this.nearby = new Set(nearbyIds);
  }

  // 天体 id あるいはラグランジュ点 id の表示判定。星系に無い id はすべて伏せた判定になる。
  body(id: string): MapVisibility {
    const cached = this.bodyResults.get(id);
    if (cached !== undefined) return cached;

    const result = this.computeBody(id);
    this.bodyResults.set(id, result);
    return result;
  }

  // body() の判定そのもの。
  private computeBody(id: string): MapVisibility {
    if (isLagrangeId(id)) {
      const shown = this.toggles.lagrangeName;
      return { icon: shown, label: shown, orbit: false, pickable: shown };
    }
    const cls = this.celestialBodies.bodyClassOf(id);
    if (cls === null) return noVisibility();

    if (!celestialClassVisible(cls, this.toggles)) return noVisibility();
    // 注視・近傍で格上げされた天体は、名前トグルが閉じていても名前とアイコンを出す。
    const shown = this.alwaysVisible.has(id) || celestialNameVisible(cls, this.toggles);
    return { icon: shown, label: shown, orbit: this.orbitForBody(id, cls), pickable: shown };
  }

  // ゲーム内 entity の種別ごとの表示判定。isActivePlayer はいま操作している自艦にだけ立てる。
  entity(kind: DynamicEntityKind, isActivePlayer = false): MapVisibility {
    const key = `${kind}:${isActivePlayer ? 'active' : 'inactive'}`;
    const cached = this.entityResults.get(key);
    if (cached !== undefined) return cached;

    const result = this.computeEntity(kind, isActivePlayer);
    this.entityResults.set(key, result);
    return result;
  }

  // entity() の判定そのもの。
  private computeEntity(kind: DynamicEntityKind, isActivePlayer: boolean): MapVisibility {
    const keys = ENTITY_KEYS[kind];
    // 操作対象の自艦は、クラスを畳んでも現在位置を失わないように点だけ残す。ただし
    // 艦名/軌道線は名前トグルに従うので、例外が表示設定を無効化しない。
    const active = kind === 'player' && isActivePlayer;
    if (!active && !mapDisplayCategoryVisible(this.toggles, keys.category)) return noVisibility();
    const nameToggle = this.toggles[keys.name];
    const icon = active || nameToggle;
    return { icon, label: nameToggle, orbit: this.toggles[keys.orbit], pickable: icon || nameToggle };
  }

  // その天体の軌道線を引くか。惑星・準惑星・小天体は分類のトグルだけで決まり、衛星はさらに
  // 主天体が注視中の系か、近傍のいずれかであることを要する(全惑星の衛星軌道が
  // 一度に出ると読めなくなるため)。
  private orbitForBody(id: string, cls: CelestialClass): boolean {
    switch (cls) {
      case 'planet': return this.toggles.planetOrbit;
      case 'dwarf': return this.toggles.dwarfOrbit;
      case 'smallBody': return this.toggles.smallBodyOrbit;
      case 'satellite': {
        const planetId = this.celestialBodies.motionOf(id).primary?.id ?? null;
        if (planetId === null) return false;
        return this.toggles.satelliteOrbit
          && (focusSystemOf(this.celestialBodies, this.focusId) === planetId || this.nearby.has(id));
      }
      default: return false;
    }
  }
}
