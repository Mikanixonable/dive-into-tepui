// 軌道上の特徴点(赤道交点 EqAN/EqDN、相対交点 AN/DN など)の計算を行う純粋物理計算層。
import { Attractor, frameOfAttractor, frameOfAttractorAt, orbitalElementsOf } from './attractor';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from './elements';
import { frameKinematicState, toFrameState, toInertialState } from './frame';
import { KinematicState } from './kinematic-state';
import { findEquatorCrossings } from './trajectory-features';
import { Vec3 } from './vec3';

export interface OrbitNodeState {
  readonly r: KinematicState['r'];
  readonly t: KinematicState['t'];
}

export interface OrbitCrossingsResult {
  readonly asc: OrbitNodeState;
  readonly desc: OrbitNodeState;
}

// 軌道状態またはサンプル点列から赤道交点(EqAN / EqDN)を求める純粋関数
export function solveEquatorCrossings(
  state: KinematicState,
  center: Attractor,
  eqNormal: Vec3,
  samples: readonly KinematicState[] | null = null,
): OrbitCrossingsResult | null {
  if (samples) {
    const { ascending, descending } = findEquatorCrossings(samples, center, eqNormal);
    return ascending && descending ? { asc: ascending, desc: descending } : null;
  }

  const el = orbitalElementsOf(state, center);
  const nodes = el && nodeAnomalies(el, eqNormal);
  if (!el || !nodes) return null;

  const tf = frameOfAttractor(center);
  const relative = toFrameState(tf, state);
  const nodeState = (nu: number): KinematicState => {
    const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
    const t = state.t + (isFinite(dt) ? dt : 0);
    return toInertialState(
      frameOfAttractorAt(center, t),
      t,
      frameKinematicState(positionOnOrbit(el, nu), relative.v),
    );
  };

  return { asc: nodeState(nodes.asc), desc: nodeState(nodes.desc) };
}
