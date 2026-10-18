// 遷移候補の求解。出発時刻×飛行時間の格子をランベルト問題で結び、得られたインパルスの
// 列を「Δv × 到着時刻」の候補として返す。方式の選択はここでは行わず、候補が方式名を
// 持つ(SPEC/PLAN.md「遷移方式」)。船の出発前の運動は二体問題として要素から伝播し、
// 全力学モデルへの寄りは trajectory-correction.ts が担う。THREE/DOM 非依存。
import { add, len, sub } from '../math/vec3';
import type { CelestialBody } from './celestial-body';
import { keplerPeriod, orbitalElementsOf, stateOnOrbitAt } from './elements';
import { kinematicState, type KinematicState } from './kinematic-state';
import { solveLambert } from './lambert';

// 求解済みの1候補。nodes は計画ノードへそのまま書ける噴射後の絶対状態の列で、
// 先頭が出発インパルス、末尾が到着インパルス。
export interface TransferCandidate {
  readonly method: 'lambert';
  readonly departAt: number;   // 出発インパルスの時刻 [simTime s]
  readonly arriveAt: number;   // 目標へ到達する時刻 [simTime s]
  readonly deltaV: number;     // インパルス合計 [m/s]
  readonly departDeltaV: number;
  readonly arriveDeltaV: number;
  readonly nodes: readonly KinematicState[];
}

// 会合目標の状態の問い合わせ口。軌道標識・天体・個体のどれでも同じ形に包む。
export interface TransferPlannerTarget {
  // 時刻 t の絶対 ECI 状態。求まらない時刻は null。
  stateAt(t: number): KinematicState | null;
  // 位相配置が繰り返す見通しの周期 [s]。窓の外を探す目安。不明・非周期なら null。
  readonly period: number | null;
}

export interface TransferPlannerConstraints {
  readonly deadline?: number;    // 到着はこの時刻まで [simTime s]
  readonly maxDeltaV?: number;   // インパルス合計の上限 [m/s]
  readonly departures?: number;  // 出発時刻の格子点数
  readonly maxCandidates?: number;
}

const DEFAULT_DEPARTURES = 24;
const DEFAULT_CANDIDATES = 8;
// 出発側の公転周期に対する飛行時間の比の格子。
const TOF_FRACTIONS: readonly number[] = [0.25, 0.4, 0.55, 0.75, 1.0];
const MIN_DEPART_LEAD = 30; // 出発までの最小猶予 [s] — 求解中の時間バリアと同じ余裕

// shipState(絶対 ECI)の船が center の重力圏で target へ会合する遷移候補を返す。
// 出発側が双曲線・放物線上にある、または要素が求まらない場合は空。
export function planTransfers(
  shipState: KinematicState,
  center: CelestialBody,
  target: TransferPlannerTarget,
  constraints: TransferPlannerConstraints = {},
): TransferCandidate[] {
  const mu = center.def.mu;
  const t0 = shipState.t;
  const elements = orbitalElementsOf(shipState, center, t0);
  if (elements === null || !(elements.a > 0)) return [];
  const shipPeriod = keplerPeriod(elements.a, mu);
  const window = target.period ?? shipPeriod;
  const nDepart = Math.max(1, constraints.departures ?? DEFAULT_DEPARTURES);
  const maxKeep = Math.max(1, constraints.maxCandidates ?? DEFAULT_CANDIDATES);

  const out: TransferCandidate[] = [];
  for (let i = 0; i < nDepart; i++) {
    const tD = t0 + MIN_DEPART_LEAD + (window * i) / nDepart;
    if (constraints.deadline !== undefined && tD > constraints.deadline) continue;
    const depart = stateOnOrbitAt(elements, tD); // 中心相対
    if (depart === null) continue;
    const r1 = depart.r;
    for (const f of TOF_FRACTIONS) {
      const tof = shipPeriod * f;
      const tA = tD + tof;
      if (constraints.deadline !== undefined && tA > constraints.deadline) continue;
      const targetState = target.stateAt(tA);
      if (targetState === null) continue;
      const centerA = center.stateAt(tA);
      const r2 = sub(targetState.r, centerA.r);
      const vT = sub(targetState.v, centerA.v);
      for (const sol of solveLambert(r1, r2, tof, mu)) {
        const dv1 = len(sub(sol.v1, depart.v));
        const dv2 = len(sub(vT, sol.v2));
        const total = dv1 + dv2;
        if (!(total > 0)) continue;
        if (constraints.maxDeltaV !== undefined && total > constraints.maxDeltaV) continue;
        const centerD = center.stateAt(tD);
        out.push({
          method: 'lambert',
          departAt: tD,
          arriveAt: tA,
          deltaV: total,
          departDeltaV: dv1,
          arriveDeltaV: dv2,
          nodes: [
            kinematicState(tD, add(r1, centerD.r), add(sol.v1, centerD.v)),
            kinematicState(tA, add(r2, centerA.r), add(vT, centerA.v)),
          ],
        });
      }
    }
  }
  // Δv 昇順で上位を残し、返す候補は到着時刻順(早い到着ほど先)に並べる。
  out.sort((a, b) => a.deltaV - b.deltaV);
  const kept = out.slice(0, maxKeep);
  kept.sort((a, b) => a.arriveAt - b.arriveAt);
  return kept;
}
