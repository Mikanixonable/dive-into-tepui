import { sameSystemIds } from '../celestial/body-visibility';
import { BodyClass, bodyClassOf } from '../celestial/body-class';
import { ObjectPickerGroup } from '../hud/windows/object-picker';
import { celestialBodyName } from '../hud/frame/frame-labels';
import type { CelestialBodyDef } from '../../physics/celestial-motion';
import { EARTH } from '../../physics/solar-system/earth-system';
import { J2_EARTH, MU_EARTH, R_EARTH } from '../../physics/solar-system/constants';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';

// ラグランジュ点を持てる天体(惑星 + 衛星)を副天体として列挙する。軌道要素指定の基準天体も
// これを使う(公転していない恒星を周回の中心には選べない)。
export function orbitingIdsOf(ephemeris: Ephemeris): readonly string[] {
  return Object.keys(ephemeris.registry).filter((id) => ephemeris.motionOf(id).kind !== 'star');
}

// 天体の候補をクラス別のまとまりへ組む。先頭は「いま選んでいる系」— 実際に選ばれるのは
// ほぼ常に同じ系の別天体なので、1クリック目に置く。
export function bodyGroupsOf(
  ephemeris: Ephemeris, items: readonly (readonly [string, string])[], selected: string,
): readonly ObjectPickerGroup<string>[] {
  const near0 = sameSystemIds(ephemeris, selected);
  const near = items.filter(([id]) => near0.has(id));
  const byClass = (cls: BodyClass) => items.filter(([id]) => bodyClassOf(ephemeris, id) === cls);
  return [
    { label: 'いま選んでいる系', items: near },
    { label: '惑星', items: byClass('planet') },
    { label: '衛星', items: byClass('satellite') },
    { label: '準惑星', items: byClass('dwarf') },
    { label: '小天体', items: byClass('smallBody') },
  ].filter((g) => g.items.length > 0);
}

// 表示名を「中心天体名-自分の名」として ephemeris から組む。
export function lagrangeSystemItemsOf(ephemeris: Ephemeris, orbitingIds: readonly string[]): readonly (readonly [string, string])[] {
  // 共線点が行き先として意味を持つ系だけを出す。質量が未測定の天体では質量比が 0 になり、
  // 共線点の距離比を解く反復が収束せず NaN の状態を返すため、選ばせてはいけない。
  return orbitingIds.filter((id) => ephemeris.hasUsableCollinearPoints(id, C.LAGRANGE_MIN_CLEARANCE_RATIO)).map((id) => {
    const primary = ephemeris.motionOf(id).primary?.id ?? null;
    const primaryName = primary === null ? celestialBodyName(id) : celestialBodyName(primary);
    return [id, `${primaryName}-${celestialBodyName(id)}`] as const;
  });
}

// 副天体とその主天体の距離 [km](= 副天体の軌道長半径)。恒星を渡すと例外になる。
export function primaryDistanceKm(def: CelestialBodyDef): number {
  if (!('orbit' in def)) throw new Error(`primaryDistanceKm: ${def.id} は恒星なので公転していない`);
  return ('kepler' in def.orbit ? def.orbit.kepler.a : def.orbit.a) / 1e3;
}

const DEG = Math.PI / 180;

// 太陽同期軌道の傾斜角: その高度の円軌道が J2 摂動で受ける昇交点歳差(dynamics.ts の j2Accel と
// 同じ式)が、地球の公転角速度(地球の公転要素そのもの)にちょうど一致する条件から
// 逆算する。retrograde 解(i>90°)が太陽同期の側。
export function sunSyncInclinationDeg(altKm: number): number {
  const a = R_EARTH + altKm * 1e3;
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  const earthOrbitRate = EARTH.orbit.lRate;
  const cosI = earthOrbitRate / (-1.5 * n * J2_EARTH * (R_EARTH / a) ** 2);
  return Math.acos(cosI) / DEG;
}
