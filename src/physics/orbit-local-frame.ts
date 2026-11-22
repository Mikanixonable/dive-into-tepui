// 周回中の物体の姿勢の基準になる局所系(LVLH)。動径外向き・軌道面法線・面内の進行方向を軸にとり、
// 周回に合わせて回る。どの天体も周回していなければ null を返し、呼び手は慣性系で進める。
import { cross, lenSq, norm, scale, sub, type Vec3 } from '../math/vec3';
import { qFromForwardUp } from '../math/quat';
import type { KinematicState } from './kinematic-state';
import type { CelestialBody } from './celestial-body';
import { orbitingAttractorOf } from './attractor';
import type { RotatingFrame } from './attitude';

// 角運動量・動径がほぼ 0 の退化した状態では局所系を組めない。
const DEGENERATE_EPS = 1e-12;

// state が周回している天体を中心にした局所系。中心天体の位置と速度は state と同じ時刻・同じ原点で測る。
export function orbitLocalFrame(
  state: KinematicState, bodies: readonly CelestialBody[], pivot: number,
): RotatingFrame | null {
  const attractor = orbitingAttractorOf(state, bodies, pivot);
  if (attractor === null) return null;
  const center = attractor.stateAt(pivot, state.t);
  const rRel: Vec3 = sub(state.r, center.r);
  const vRel: Vec3 = sub(state.v, center.v);
  const h = cross(rRel, vRel);
  const rSq = lenSq(rRel);
  if (rSq < DEGENERATE_EPS || lenSq(h) < DEGENERATE_EPS) return null;
  const x = norm(rRel);
  const z = norm(h);
  const y = cross(z, x);
  const q = qFromForwardUp(y, x);
  if (q === null) return null;
  // 局所系の角速度は h / r²。円軌道では平均運動に一致する。
  return { q, omega: scale(h, 1 / rSq) };
}
