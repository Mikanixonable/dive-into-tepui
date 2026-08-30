// 軌道上の特徴点(赤道交点 EqAN/EqDN、相対交点 AN/DN など)の計算を行う純粋物理計算層。
import { CelestialBody, celestialBodyPositionAt, frameOfCelestialBody, orbitalElementsOf } from './celestial-body';
import { nodeAnomalies, positionOnOrbit, tofBetween, trueAnomalyAt } from './elements';
import { toFrameState } from './frame';
import { KinematicState } from './kinematic-state';
import { findEquatorCrossings } from './trajectory-features';
import { Vec3, add } from '../math/vec3';

export interface OrbitNodeState {
  // ノード通過位置(ECI)。**中心天体の位置 + 軌道上の相対位置**というアフィン和で組むので、
  // KinematicState の原点札は付かない — 札は状態ベクトルから取り出したものだけが持つ。
  readonly r: Vec3;
  readonly t: KinematicState['t'];
}

export interface OrbitCrossingsResult {
  readonly asc: OrbitNodeState;
  readonly desc: OrbitNodeState;
}

// 折れ線または軌道状態から赤道交点(EqAN / EqDN)を求める純粋関数。paths は時刻昇順に並んだ
// 折れ線の列(区間ごとに1本)で、渡されたときはその上を順に探して最初に見つかった昇交点・降交点を
// 返す。空なら state の軌道要素から解析的に求める。ノード通過時刻 t における中心天体の ECI 位置は、
// 呼び出し側が精密な天体暦を持っていれば centerPositionAt でそれを渡すこと — 既定の
// celestialBodyPositionAt は center.state 起点の弾道外挿でしかなく、月のように数時間〜数日先まで
// 公転するものには不十分(表示側が精密暦で un-bake すると、この弾道外挿との差がそのまま交点位置の
// ズレになる)。
export function solveEquatorCrossings(
  state: KinematicState,
  center: CelestialBody,
  eqNormal: Vec3,
  paths: readonly (readonly KinematicState[])[] = [],
  centerPositionAt: (t: number) => Vec3 = (t) => celestialBodyPositionAt(center, t),
): OrbitCrossingsResult | null {
  if (paths.length > 0) {
    let asc: KinematicState | null = null;
    let desc: KinematicState | null = null;
    for (const samples of paths) {
      const { ascending, descending } = findEquatorCrossings(samples, centerPositionAt, eqNormal);
      asc ??= ascending;
      desc ??= descending;
      if (asc && desc) break;
    }
    return asc && desc ? { asc, desc } : null;
  }

  const el = orbitalElementsOf(state, center);
  const nodes = el && nodeAnomalies(el, eqNormal);
  if (!el || !nodes) return null;

  const relative = toFrameState(frameOfCelestialBody(center), state);
  const nodeState = (nu: number): OrbitNodeState => {
    const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
    const t = state.t + (isFinite(dt) ? dt : 0);
    return { r: add(centerPositionAt(t), positionOnOrbit(el, nu)), t };
  };

  return { asc: nodeState(nodes.asc), desc: nodeState(nodes.desc) };
}
