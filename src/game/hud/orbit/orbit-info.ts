// 軌道エンティティの基準・軌道要素・相対情報を導出する純粋関数群。
import { CelestialBody, strongestAttractor } from '../../../physics/celestial-body';
import { apsisAltitudes } from '../../../physics/elements';
import { kinematicState } from '../../../physics/kinematic-state';
import { dot, len, sub, Vec3 } from '../../../physics/vec3';
import type { GameEntity } from '../../game-entity/game-entity';
import type { OrbitReference } from '../../orbit-reference';
import { celestialBodyName } from '../frame/frame-labels';

export interface OrbitInfo {
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
// ap/pe/inc/period を NaN にする。
export function orbitInfo(entity: GameEntity, reference: OrbitReference): OrbitInfo {
  // reference 系での相対位置・速度(高度・相対速度の元)。
  const rel = kinematicState(entity.state.t, sub(entity.state.r, reference.state.r), sub(entity.state.v, reference.state.v));
  // reference が重力中心のときだけ軌道要素・遠地点/近地点が求まる。
  const el = reference.attractor ? entity.orbitalElementsAround(reference.attractor) : null;
  const apsis = el ? apsisAltitudes(el) : null;
  return {
    centerId: reference.id,
    centerName: celestialBodyName(reference.id),
    alt: len(rel.r) - (reference.attractor?.radius ?? 0),
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

export interface RelativeInfo {
  dist: number;
  closing: number; // 接近速度 [m/s] (正 = 近づいている)
  relSpeed: number;
  relIncDeg: number; // self 軌道面との相対傾斜角 [deg]
}

// self から見た other の距離・接近速度・相対速度・相対傾斜角を導出する。相対傾斜角は
// 双方の基準天体(strongestAttractor)が一致するときのみ意味を持ち、異なる場合は NaN にする。
export function relativeInfo(self: GameEntity, other: GameEntity, celestialBodies: readonly CelestialBody[]): RelativeInfo {
  const selfCenter = strongestAttractor(self.state.r, celestialBodies);
  const otherCenter = strongestAttractor(other.state.r, celestialBodies);
  const selfEl = self.orbitalElementsAround(selfCenter);
  const otherEl = other.orbitalElementsAround(otherCenter);
  const relP = sub(other.state.r, self.state.r);
  const relV = sub(other.state.v, self.state.v);
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
