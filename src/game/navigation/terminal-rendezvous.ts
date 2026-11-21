// 会合遷移の終端誘導つき求解。目標そのものではなく、目標の回転局所系(LVLH)に固定した
// 点へ着く遷移候補を作る — 敵への到達は後方の待機点で保持して手動交戦へ、味方艦・基地への
// 到達はドッキング方向へ近い接近点で保持して手動ドッキングへ渡す計画になる
// (SPEC/PLAN.md「航行指令」)。
// 主遷移は到着点を局所系へずらした目標へのランベルト(transfer-planner.ts)で求め、
// 待機点から接近点までの末段は CW 2インパルス(relative-motion.ts)を末尾ノードへ連結する。
import { add, len, sub, v3 } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import {
  cwTwoImpulseTransfer, frameDirectionToEci, holdStateAt, localFrameOf,
} from '../../physics/relative-motion';
import {
  planTransfers, type TransferCandidate, type TransferPlannerConstraints,
  type TransferPlannerTarget,
} from '../../physics/transfer-planner';

// 末端プロファイル。敵なら待機点(standoff)、味方艦・基地なら接近点(approach)へ着く。
// distance は目標からの距離 [m]。
export type TerminalProfile =
  | { readonly kind: 'standoff'; readonly distance: number }
  | { readonly kind: 'approach'; readonly distance: number };

// 接近プロファイルで CW 区間へ入る待機点(終端入口)の距離 [m]。調整値。
const ENTRY_DISTANCE = 10_000;
// 接近点への小遷移へ入る前に待機点へ置く保持時間 [s]。調整値。
const TERMINAL_HOLD_SECONDS = 600;
// CW 区間の飛行時間は目標の軌道周期のこの比 — nt=π/2 で Φ_rv の特異点(nt=π の整数倍)を避ける。
const CW_TOF_FRACTION = 0.25;

// 局所系の後方(面内進行方向の負)へ distance [m] ずらした保持点を指す目標。
function holdPointTarget(
  target: TransferPlannerTarget, center: CelestialBody, distance: number,
): TransferPlannerTarget {
  return {
    period: target.period,
    stateAt: (t) => {
      const targetState = target.stateAt(t);
      if (targetState === null) return null;
      return holdStateAt(targetState, center.stateAt(t), v3(0, -distance, 0));
    },
  };
}

// 時刻 t の目標の軌道角速度 [rad/s]。求まらないとき null。
function meanMotionAt(
  target: TransferPlannerTarget, center: CelestialBody, t: number,
): number | null {
  const targetState = target.stateAt(t);
  if (targetState === null) return null;
  const centerState = center.stateAt(t);
  return localFrameOf(
    sub(targetState.r, centerState.r), sub(targetState.v, centerState.v))?.n ?? null;
}

// 待機点での保持を挟み、待機点→接近点の CW 2インパルス小遷移を末尾ノードへ連結する。
// 保持点・接近点の状態や CW 解が組めない候補は null。
function terminalHop(
  candidate: TransferCandidate,
  target: TransferPlannerTarget,
  center: CelestialBody,
  approachDistance: number,
): TransferCandidate | null {
  const tDepart = candidate.arriveAt + TERMINAL_HOLD_SECONDS;
  const departTarget = target.stateAt(tDepart);
  if (departTarget === null) return null;
  const centerDepart = center.stateAt(tDepart);
  const frameDepart = localFrameOf(
    sub(departTarget.r, centerDepart.r), sub(departTarget.v, centerDepart.v));
  if (frameDepart === null || !(frameDepart.n > 0)) return null;
  const tof = CW_TOF_FRACTION * (2 * Math.PI / frameDepart.n);
  const tArrive = tDepart + tof;
  const arriveTarget = target.stateAt(tArrive);
  if (arriveTarget === null) return null;
  const centerArrive = center.stateAt(tArrive);
  const frameArrive = localFrameOf(
    sub(arriveTarget.r, centerArrive.r), sub(arriveTarget.v, centerArrive.v));
  if (frameArrive === null) return null;

  // 待機点(系内 (0,−D,0)、系内速度 0)から接近点 (0,−d,0) への 2インパルス解。
  const transfer = cwTwoImpulseTransfer(
    { r: v3(0, -ENTRY_DISTANCE, 0), v: v3() },
    frameDepart.n,
    tof,
    v3(0, -approachDistance, 0),
  );
  if (transfer === null) return null;
  const standoff = holdStateAt(departTarget, centerDepart, v3(0, -ENTRY_DISTANCE, 0));
  const approach = holdStateAt(arriveTarget, centerArrive, v3(0, -approachDistance, 0));
  if (standoff === null || approach === null) return null;

  const departDeltaV = frameDirectionToEci(frameDepart, transfer.departDeltaV);
  const arriveDeltaV = frameDirectionToEci(frameArrive, transfer.arriveDeltaV);
  return {
    method: 'lambert',
    departAt: candidate.departAt,
    arriveAt: tArrive,
    deltaV: candidate.deltaV + len(departDeltaV) + len(arriveDeltaV),
    departDeltaV: candidate.departDeltaV,
    arriveDeltaV: len(arriveDeltaV),
    nodes: [
      ...candidate.nodes,
      kinematicState<'eci'>(tDepart, standoff.r, add(standoff.v, departDeltaV)),
      approach,
    ],
  };
}

// shipState(ECI)の船が center の重力圏で target へ会合し、profile の終端点へ着く遷移候補。
// standoff なら待機点到着でノード列を終え(2ノード)、approach なら待機点→接近点の
// CW 区間を連結する(4ノード)。目標・保持点の局所系が組めない入力は空を返す。
export function planRendezvous(
  shipState: KinematicState,
  center: CelestialBody,
  target: TransferPlannerTarget,
  profile: TerminalProfile,
  constraints: TransferPlannerConstraints = {},
): TransferCandidate[] {
  const entryDistance = profile.kind === 'approach' ? ENTRY_DISTANCE : profile.distance;
  const inner = { ...constraints };
  if (profile.kind === 'approach' && constraints.deadline !== undefined) {
    // 末尾の保持と CW 区間ぶんだけ、ランベルト側の到着期限を前倒しする。
    const n = meanMotionAt(target, center, shipState.t);
    const tail = TERMINAL_HOLD_SECONDS + (n !== null ? CW_TOF_FRACTION * (2 * Math.PI / n) : 0);
    inner.deadline = constraints.deadline - tail;
  }
  const candidates = planTransfers(
    shipState, center, holdPointTarget(target, center, entryDistance), inner);
  if (profile.kind === 'standoff') return candidates;
  const out: TransferCandidate[] = [];
  for (const candidate of candidates) {
    const terminal = terminalHop(candidate, target, center, profile.distance);
    if (terminal === null) continue;
    if (constraints.maxDeltaV !== undefined && terminal.deltaV > constraints.maxDeltaV) continue;
    out.push(terminal);
  }
  return out;
}
