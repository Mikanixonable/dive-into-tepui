// 軌道の指定に要る、天体まわりの選択肢と諸元。基準天体とラグランジュ系の候補を登録天体から組み、
// 主天体間距離と太陽同期軌道の軌道傾斜角を算出・提供する。
import { OrbitingMotion } from '../../physics/celestial-motion';
import { EARTH, J2_EARTH, MU_EARTH, R_EARTH } from '../celestial/solar-system/earth-system';
import { LAGRANGE_MIN_CLEARANCE_RATIO } from '../celestial/lagrange-id';
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';
import type { ObjectPickerGroup } from '../hud/windows/object-picker';
import type { CelestialBodyDef } from '../../physics/celestial-body-def';
import type { CelestialBodies } from '../celestial/celestial-bodies';

// ラグランジュ系の副天体・軌道要素の基準天体になれる天体(= 公転しているもの)を列挙する。
export function orbitingIdsOf(celestialBodies: CelestialBodies): readonly string[] {
  return celestialBodies.celestialMotions.filter((b) => b.kind !== 'star').map((b) => b.id);
}

// 天体の候補をクラス別のまとまりへ組む。先頭は「いま選んでいる系」— 実際に選ばれるのは
// ほぼ常に同じ系の別天体なので、1クリック目に置く。
export function bodyGroupsOf(
  celestialBodies: CelestialBodies, items: readonly (readonly [string, string])[], selected: string,
): readonly ObjectPickerGroup<string>[] {
  const near0 = celestialBodies.sameSystemIds(selected);
  const near = items.filter(([id]) => near0.has(id));
  const byClass = (cls: CelestialClass) => items.filter(([id]) => celestialBodies.bodyClassOf(id) === cls);
  return [
    { label: 'いま選んでいる系', items: near },
    { label: '惑星', items: byClass('planet') },
    { label: '衛星', items: byClass('satellite') },
    { label: '準惑星', items: byClass('dwarf') },
    { label: '小天体', items: byClass('smallBody') },
  ].filter((g) => g.items.length > 0);
}

// ラグランジュ系の候補を [副天体 id, 「主天体名-副天体名」] で組む。
export function lagrangeSystemItemsOf(
  celestialBodies: CelestialBodies, orbitingIds: readonly string[],
): readonly (readonly [string, string])[] {
  // 共線点が行き先として意味を持つ系だけを出す。
  const usable = (id: string): boolean => {
    const motion = celestialBodies.motionOf(id);
    return motion instanceof OrbitingMotion && motion.hasUsableCollinearPoints(LAGRANGE_MIN_CLEARANCE_RATIO);
  };
  return orbitingIds.filter(usable).map((id) => {
    const primary = celestialBodies.motionOf(id).primary?.id ?? null;
    const primaryName = celestialBodies.nameOf(primary ?? id);
    return [id, `${primaryName}-${celestialBodies.nameOf(id)}`] as const;
  });
}

// 副天体とその主天体の距離 [km](= 副天体の軌道長半径)。恒星を渡すと例外になる。
export function primaryDistanceKm(def: CelestialBodyDef): number {
  if (!('orbit' in def)) throw new Error(`primaryDistanceKm: ${def.id} は恒星なので公転していない`);
  return ('kepler' in def.orbit ? def.orbit.kepler.a : def.orbit.a) / 1e3;
}

const DEG = Math.PI / 180;

// 太陽同期軌道の傾斜角: その高度の円軌道が J2 摂動で受ける昇交点歳差が、地球の公転角速度
// (地球の公転要素そのもの)にちょうど一致する条件から逆算する。retrograde 解(i>90°)が太陽同期の側。
export function sunSyncInclinationDeg(altKm: number): number {
  const a = R_EARTH + altKm * 1e3;
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  const earthOrbitRate = EARTH.orbit.lRate;
  const cosI = earthOrbitRate / (-1.5 * n * J2_EARTH * (R_EARTH / a) ** 2);
  return Math.acos(cosI) / DEG;
}
