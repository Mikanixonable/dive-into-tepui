// 軌道上の特徴点(赤道交点 EqAN/EqDN、相対交点 AN/DN など)の計算を行う純粋物理計算層。
import { Attractor, attractorPositionAt, frameOfAttractor, orbitalElementsOf } from './attractor';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from './elements';
import { toFrameState } from './frame';
import { KinematicState } from './kinematic-state';
import { findEquatorCrossings } from './trajectory-features';
import { Vec3, add } from './vec3';

export interface OrbitNodeState {
  readonly r: KinematicState['r'];
  readonly t: KinematicState['t'];
}

export interface OrbitCrossingsResult {
  readonly asc: OrbitNodeState;
  readonly desc: OrbitNodeState;
}

// 軌道状態またはサンプル点列から赤道交点(EqAN / EqDN)を求める純粋関数。ノード通過時刻 t
// における中心天体の ECI 位置は、呼び出し側が精密な天体暦を持っていれば centerPositionAt で
// それを渡すこと — 既定の attractorPositionAt は center.state 起点の弾道外挿でしかなく、
// 月のように数時間〜数日先まで公転するものには不十分(表示側が精密暦で un-bake すると、
// この弾道外挿との差がそのまま交点位置のズレになる)。
export function solveEquatorCrossings(
  state: KinematicState,
  center: Attractor,
  eqNormal: Vec3,
  samples: readonly KinematicState[] | null = null,
  centerPositionAt: (t: number) => Vec3 = (t) => attractorPositionAt(center, t),
): OrbitCrossingsResult | null {
  if (samples) {
    const { ascending, descending } = findEquatorCrossings(samples, centerPositionAt, eqNormal);
    return ascending && descending ? { asc: ascending, desc: descending } : null;
  }

  const el = orbitalElementsOf(state, center);
  const nodes = el && nodeAnomalies(el, eqNormal);
  if (!el || !nodes) return null;

  const relative = toFrameState(frameOfAttractor(center), state);
  const nodeState = (nu: number): OrbitNodeState => {
    const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
    const t = state.t + (isFinite(dt) ? dt : 0);
    return { r: add(centerPositionAt(t), positionOnOrbit(el, nu)), t };
  };

  return { asc: nodeState(nodes.asc), desc: nodeState(nodes.desc) };
}
