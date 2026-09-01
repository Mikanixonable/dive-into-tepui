// 天体とゲーム内 entity に共通するマップ表示ポリシー。
// category/icon/label/orbit/pickable を各描画・選択系で個別に解釈しないための正本。
import { celestialClassVisible, celestialNameVisible, type MapDisplayToggles } from './display-toggles';
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';
import type { CelestialSystem } from '../celestial/celestial-system';
import { isLagrangeId, lagrangeParentId } from '../celestial/lagrange-id';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';

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
  enemy: { category: 'enemyVisible', name: 'enemyName', orbit: 'enemyOrbit' },
  ammo: { category: 'ammoVisible', name: 'ammoName', orbit: 'ammoOrbit' },
  fuel: { category: 'fuelVisible', name: 'fuelName', orbit: 'fuelOrbit' },
  base: { category: 'baseVisible', name: 'baseName', orbit: 'baseOrbit' },
};

// フォーカス対象が属する惑星系の代表 id(惑星なら自分、衛星なら親惑星)。ラグランジュ点の
// id は所属天体の id へ戻してから引く。天体でない・恒星をフォーカスしているなら null。
function focusSystemOf(celestialSystem: CelestialSystem, focusId: string | undefined): string | null {
  if (focusId === undefined) return null;
  const body = celestialSystem.find(lagrangeParentId(focusId));
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
  celestialSystem: CelestialSystem, focusId: string | undefined,
  nearbyIds: Iterable<string> = [],
  toggles?: MapDisplayToggles,
): ReadonlySet<string> {
  // 未登録の id は 'planet' として扱う。トグルを渡されていない呼び出しはクラスで絞らない。
  const classVisible = (id: string): boolean => toggles === undefined
    || celestialClassVisible(celestialSystem.find(id)?.bodyClass ?? 'planet', toggles);
  const ids = new Set<string>();
  for (const motion of celestialSystem.celestialMotions) {
    if (motion.kind === 'star') ids.add(motion.id);
  }

  // nearbyIds は systemMembersAt() など、呼び出し側がカメラ位置から求めた系の集合。
  // 未登録の重力源が混ざっても、ここは天体ラベルの集合なので無視する。
  for (const id of nearbyIds) {
    if (celestialSystem.has(id) && classVisible(id)) ids.add(id);
  }

  if (focusId === undefined) return ids;

  for (const id of celestialSystem.ancestorsOf(focusId)) {
    if (classVisible(id)) ids.add(id);
  }
  // 兄弟は「惑星系の中の兄弟」に限る。恒星の子はすべて互いに兄弟なので、そこまで含めると
  // 惑星にフォーカスしただけで全太陽周回天体が出てしまう(惑星どうしの表示は planetOrbit/
  // planetName トグルが別途受け持つ)。
  const focusParent = celestialSystem.find(focusId)?.motion.primary ?? null;
  const siblingsMatter = focusParent !== null && focusParent.kind !== 'star';
  for (const id of celestialSystem.sameSystemIds(focusId)) {
    // focusId 自身は未登録(生存中の重力天体)でもありうるので、親を引く前に弾く。
    if ((siblingsMatter || id === focusId
      || (celestialSystem.find(id)?.motion.primary?.id ?? null) === focusId) && classVisible(id)) {
      ids.add(id);
    }
  }
  return ids;
}

// すべての項目を伏せた判定。カテゴリが閉じていれば、残りの項目は問わずこれになる。
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

  // focusId は注視中の対象、nearbyIds は近傍として常時表示へ格上げする天体の id。どちらも
  // 省くと格上げが効かず、トグルだけで決まる。
  constructor(
    private readonly celestialSystem: CelestialSystem,
    private readonly toggles: MapDisplayToggles,
    private readonly focusId?: string,
    nearbyIds: Iterable<string> = [],
  ) {
    this.alwaysVisible = alwaysFullyVisibleIds(celestialSystem, focusId, nearbyIds, toggles);
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

  // body() の判定そのもの。ラグランジュ点は専用の2トグルだけで決まり、天体は分類トグルが
  // 開いていることを前提に、名前と軌道線をそれぞれの規則で決める。
  private computeBody(id: string): MapVisibility {
    if (isLagrangeId(id)) {
      const category = this.toggles.lagrangeVisible;
      const shown = category && this.toggles.lagrangeName;
      return { category, icon: shown, label: shown, orbit: false, pickable: shown };
    }
    // 注視・近傍で格上げされた天体は、名前トグルが閉じていても名前とアイコンを出す。
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

  // ゲーム内 entity の種別ごとの表示判定。isActivePlayer はいま操作している自艦にだけ立てる。
  entity(kind: DynamicEntityKind, isActivePlayer = false): MapVisibility {
    const key = `${kind}:${isActivePlayer ? 'active' : 'inactive'}`;
    const cached = this.entityResults.get(key);
    if (cached !== undefined) return cached;

    const result = this.computeEntity(kind, isActivePlayer);
    this.entityResults.set(key, result);
    return result;
  }

  // entity() の判定そのもの。種別ごとのトグル3本(カテゴリ・名前・軌道線)から決まる。
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

  // その天体の軌道線を引くか。惑星・準惑星・小天体は分類のトグルだけで決まり、衛星はさらに
  // 主惑星が地球か、注視中の系か、近傍のいずれかであることを要する(全惑星の衛星軌道が
  // 一度に出ると読めなくなるため)。
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
