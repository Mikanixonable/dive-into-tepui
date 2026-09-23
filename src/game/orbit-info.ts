// 軌道エンティティの基準・軌道要素・相対情報を導出する純粋関数群。
import { strongestAttractor } from '../physics/attractor';
import { apsisAltitudes, orbitalElementsOf } from '../physics/elements';
import { kinematicState } from '../physics/kinematic-state';
import { dot, len, sub, Vec3 } from '../math/vec3';
import type { OrbitReference } from './orbit-reference';
import type { OrbitingObject } from './dynamic/dynamic-entity/orbiting-object';
import type { CelestialBody } from '../physics/celestial-body';
import type { CelestialBodies } from './celestial/celestial-bodies';

interface OrbitInfo {
  centerId: string;
  centerName: string;
  alt: number;
  spd: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
}

// エンティティの現在状態から、reference が示す基準に対する高度・相対速度・遠地点・近地点・
// 傾斜角・周期を導出する。速度は reference 自身の速度を差し引いた相対速度。reference が重力
// 中心でない(attractor=null)場合、および要素が求まらない状態(双曲線軌道等)では
// ap/pe/inc/period を NaN にする。nameOf は天体 id → 表示名(celestialSystem.nameOf)。
export function orbitInfo(
  entity: OrbitingObject, reference: OrbitReference, pivot: number, nameOf: (id: string) => string,
): OrbitInfo {
  // reference 系での相対位置・速度(高度・相対速度の元)。
  const state = entity.motion.state;
  const rel = kinematicState<'eci'>(
    state.t, sub(state.r, reference.state.r), sub(state.v, reference.state.v),
  );
  // reference が重力中心のときだけ軌道要素・遠地点/近地点が求まる。
  const el = reference.attractor ? entity.motion.orbitalElementsAround(reference.attractor, pivot) : null;
  const apsis = el ? apsisAltitudes(el) : null;
  return {
    centerId: reference.id,
    centerName: nameOf(reference.id),
    alt: len(rel.r) - (reference.attractor?.def.radius ?? 0),
    spd: len(rel.v),
    apAlt: apsis ? apsis.ap : NaN,
    peAlt: apsis ? apsis.pe : NaN,
    incDeg: el ? el.incDeg : NaN,
    period: el ? el.period : NaN,
  };
}

// hHatA と hHatB(いずれも単位角運動量ベクトル)がなす角を [deg] で返す。2つの軌道面の相対傾斜角。
export function relativeInclinationDeg(hHatA: Vec3, hHatB: Vec3): number {
  return (Math.acos(Math.max(-1, Math.min(1, dot(hHatA, hHatB)))) * 180) / Math.PI;
}

interface RelativeInfo {
  dist: number;
  closing: number; // 接近速度 [m/s] (正 = 近づいている)
  relSpeed: number;
  relIncDeg: number; // self 軌道面との相対傾斜角 [deg]
}

// self から見た other の距離・接近速度・相対速度・相対傾斜角を導出する。相対傾斜角は
// 双方の基準天体(strongestAttractor)が一致するときのみ意味を持ち、異なる場合は NaN にする。
export function relativeInfo(
  self: OrbitingObject, other: OrbitingObject,
  celestialBodies: CelestialBodies, pivot: number,
): RelativeInfo {
  const selfState = self.motion.stateAt(pivot, celestialBodies) ?? self.motion.state;
  const otherState = other.motion.stateAt(pivot, celestialBodies) ?? other.motion.state;
  const motions = celestialBodies.celestialMotions;
  const selfCenter = strongestAttractor(selfState.r, motions, pivot);
  const otherCenter = strongestAttractor(otherState.r, motions, pivot);
  const selfEl = orbitalElementsOf(selfState, selfCenter, pivot);
  const otherEl = orbitalElementsOf(otherState, otherCenter, pivot);
  const relP = sub(otherState.r, selfState.r);
  const relV = sub(otherState.v, selfState.v);
  const dist = len(relP);
  // 基準天体が一致するときのみ hHat 同士を比較できる。
  const relIncDeg =
    selfEl && otherEl && selfCenter.id === otherCenter.id
      ? relativeInclinationDeg(selfEl.hHat, otherEl.hHat)
      : NaN;
  return {
    dist,
    closing: dist > 1e-6 ? -dot(relP, relV) / dist : 0,
    relSpeed: len(relV),
    relIncDeg,
  };
}
