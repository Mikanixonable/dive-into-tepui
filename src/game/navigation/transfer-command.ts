// 遷移候補を艦の実行計画へ書き込む接続口。候補の求解は physics/transfer-planner.ts、
// ここは「目標を planner の口へ写す」「候補を Plan へ適用する」の2つだけを持つ。
import type { KinematicState } from '../../physics/kinematic-state';
import type {
  TransferCandidate, TransferPlannerTarget,
} from '../../physics/transfer-planner';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { OrbitSlot } from './orbit-slot';
import type { OrbitSlotCatalogAccess } from './orbit-slot-family';
import { orbitSlotPeriod, orbitSlotStateAt } from './orbit-slot-state';
import type { Plan, PlanExecutionMode } from '../plan/plan';

// 軌道標識の位相点を会合目標として包む。標識が解けない時刻は stateAt が null を返し、
// その格子点の候補は落ちる。
export function orbitSlotTarget(
  slot: OrbitSlot, env: CelestialBodies, catalog: OrbitSlotCatalogAccess | null,
): TransferPlannerTarget {
  return {
    stateAt: (t) => orbitSlotStateAt(slot, t, env, catalog),
    period: orbitSlotPeriod(slot, env, catalog),
  };
}

// 求解済み候補を計画へ適用する。anchor には適用時点の実状態を渡す — ノード列はその
// 状態からの未来として置き直される(PLAN.md「計画の実行」)。既存の残りノードは消える。
export function applyTransferCandidate(
  plan: Plan, anchor: KinematicState, candidate: TransferCandidate,
): void {
  plan.replaceAll(anchor, candidate.nodes);
}

// 候補を書き込まれる艦が公開する面。計画・現在状態・実行モードの切替だけを受ける。
export interface TransferCommandHost {
  readonly plan: Plan;
  readonly motion: { readonly state: KinematicState };
  setPlanExecution(mode: PlanExecutionMode): void;
}

// 選ばれた候補を host の計画へ書き込み、実行モードを自動操縦へ切り替える。
// 計画の起点には適用時点の実状態を使う。
export function commitTransferCandidate(host: TransferCommandHost, candidate: TransferCandidate): void {
  applyTransferCandidate(host.plan, host.motion.state, candidate);
  host.setPlanExecution('autopilot');
}
