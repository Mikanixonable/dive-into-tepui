// 軌道エンティティの基準天体・軌道要素・相対情報の導出。DOM に依存しない純粋関数。
import { Attractor, AttractorId, strongestAttractor } from '../../physics/attractor';
import { apsisAltitudes } from '../../physics/elements';
import { dot, len, sub } from '../../physics/vec3';
import type { GameEntity } from '../game-entity/game-entity';
import { celestialBodyName } from './frame-labels';

export interface OrbitInfo {
  centerId: AttractorId;
  centerName: string;
  alt: number;
  spd: number;
  apAlt: number;
  peAlt: number;
  incDeg: number;
  period: number;
}

// エンティティの現在状態から基準天体(strongestAttractor)・高度・速度・遠地点・近地点・
// 傾斜角・周期を導出する。要素が求まらない状態(双曲線軌道等)では ap/pe/inc/period を NaN にする。
export function orbitInfo(entity: GameEntity, attractors: readonly Attractor[]): OrbitInfo {
  const center = strongestAttractor(entity.state.r, attractors);
  const el = entity.orbitalElementsAround(center);
  // apsis 高度は center の半径基準。
  const apsis = el ? apsisAltitudes(el) : null;
  return {
    centerId: center.id,
    centerName: celestialBodyName(center.id),
    alt: len(sub(entity.state.r, center.state.r)) - center.radius,
    spd: len(entity.state.v),
    apAlt: apsis ? apsis.ap : NaN,
    peAlt: apsis ? apsis.pe : NaN,
    incDeg: el ? el.incDeg : NaN,
    period: el ? el.period : NaN,
  };
}

export interface RelativeInfo {
  dist: number;
  closing: number; // 接近速度 [m/s] (正 = 近づいている)
  relSpeed: number;
  relIncDeg: number; // self 軌道面との相対傾斜角 [deg]
}

// self から見た other の距離・接近速度・相対速度・相対傾斜角を導出する。相対傾斜角は
// 双方の基準天体(strongestAttractor)が一致するときのみ意味を持ち、異なる場合は NaN にする。
export function relativeInfo(self: GameEntity, other: GameEntity, attractors: readonly Attractor[]): RelativeInfo {
  const selfCenter = strongestAttractor(self.state.r, attractors);
  const otherCenter = strongestAttractor(other.state.r, attractors);
  const selfEl = self.orbitalElementsAround(selfCenter);
  const otherEl = other.orbitalElementsAround(otherCenter);
  const relP = sub(other.state.r, self.state.r);
  const relV = sub(other.state.v, self.state.v);
  const dist = len(relP);
  // 基準天体が一致するときのみ hHat 同士を比較できる。
  const relIncDeg =
    selfEl && otherEl && selfCenter.id === otherCenter.id
      ? (Math.acos(Math.max(-1, Math.min(1, dot(selfEl.hHat, otherEl.hHat)))) * 180) / Math.PI
      : NaN;
  return {
    dist,
    closing: dist > 1e-6 ? -dot(relP, relV) / dist : 0,
    relSpeed: len(relV),
    relIncDeg,
  };
}
