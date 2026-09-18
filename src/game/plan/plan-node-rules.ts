// 直近ノードの実行の規則: 実行時刻を過ぎたノードの消化と、接近・達成の記録。
import {
  deserializeKinematicState, type KinematicState, type SerializedKinematicState,
} from '../../physics/kinematic-state';
import { OrbitalElements, orbitalElementsOf } from '../../physics/elements';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { dot, sameVec } from '../../math/vec3';
import type { RunEventSink } from '../run-events';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { NODE_APPROACH_LEAD } from './plan';

// マニューバ達成判定(計画軌道への接近許容)
const NODE_TOL_SMA = 0.02 / 3; // 長半径の相対誤差
const NODE_TOL_ECC = 0.02 / 3; // 離心率差
const NODE_TOL_PLANE_DEG = 2.0 / 3; // 軌道面の角度差 [deg]

// 実行時刻をこれだけ過ぎたノードは計画から落とす [s]。多少の遅れなら噴射できる猶予。
const NODE_EXPIRE_GRACE = 60;

// 計画ノードの規則の直列化した形。
export interface SerializedPlanNodeRules {
  // 接近を記録したノード。まだどのノードについても記録していなければ null。
  readonly approachNotified: SerializedKinematicState | null;
}

export class PlanNodeRules {
  // events は接近・達成を記録する先。approachNotified は接近を記録したノードで、省けば未記録で始める。
  private constructor(
    private readonly events: RunEventSink,
    private approachNotified: KinematicState | null = null,
  ) {}

  // どのノードの接近もまだ記録していない状態で始める。
  public static create(events: RunEventSink): PlanNodeRules {
    return new PlanNodeRules(events);
  }

  // 直列化した規則の状態を復元する。
  public static deserialize(serialized: SerializedPlanNodeRules, events: RunEventSink): PlanNodeRules {
    const { approachNotified } = serialized;
    return new PlanNodeRules(events, approachNotified && deserializeKinematicState(approachNotified));
  }

  // 直列化した形へ変換する。
  public serialize(): SerializedPlanNodeRules {
    const node = this.approachNotified;
    return { approachNotified: node && { t: node.t, r: { ...node.r }, v: { ...node.v } } };
  }

  // 実行時刻を過ぎたノードを計画から落とし、直近ノードへの接近と計画軌道の達成を
  // ノードごとに一度だけ記録する。操作対象がいなければ何もしない。
  public update(controlled: Controllable | null, simTime: number, celestialBodies: readonly CelestialBody[]): void {
    if (!controlled) return;
    const plan = controlled.plan;
    plan.consumeNodesUpTo(simTime - NODE_EXPIRE_GRACE, controlled.motion.state);

    const node = plan.firstNode();
    // 実行の窓に入るまでは記録しない。窓の手前では操作対象はまだ噴射前の軌道にいるので、
    // 目標軌道との近さを見ても達成の判定にならない。
    if (node && simTime >= node.t - NODE_APPROACH_LEAD) {
      this.notifyApproach(node);
      this.notifyAchieved(node, controlled, celestialBodies, simTime);
    }
  }

  // 実行の窓に入ったことを記録する。
  private notifyApproach(node: KinematicState): void {
    // ノードは編集のたびに別の状態へ置き換わるので、値の一致を「同じノードについて既に記録したか」の
    // 判定にする。
    if (this.approachNotified !== null && sameState(this.approachNotified, node)) return;
    this.approachNotified = node;
    this.events.record({ kind: 'maneuverNodeApproaching' });
  }

  // 操作対象の軌道が目標軌道に十分近づいていれば達成を記録する。ノードと操作対象で最も強く引く
  // 天体が違えば、要素同士の比較自体が意味を持たないので判定しない。
  private notifyAchieved(
    node: KinematicState, controlled: Controllable,
    celestialBodies: readonly CelestialBody[], pivot: number,
  ): void {
    const plan = controlled.plan;
    const controlledCenter = strongestAttractor(
      controlled.motion.state.r, celestialBodies, pivot,
    );
    const nodeCenter = strongestAttractor(node.r, celestialBodies, pivot);
    if (controlledCenter.id !== nodeCenter.id) return;
    const targetEl = orbitalElementsOf(node, nodeCenter, pivot);
    const controlledEl = controlled.motion.orbitalElementsAround(controlledCenter, pivot);
    if (!controlledEl || !targetEl || !orbitalElementsClose(controlledEl, targetEl)) return;
    // 計画軌道へ到達したノードは、その場で実行済みとして削除する。同時刻のノードが複数あれば
    // まとめて落ちるので、残り件数は落とした後の実数を読む。
    plan.consumeNodesUpTo(node.t, controlled.motion.state);
    this.events.record({ kind: 'maneuverNodeAchieved', remaining: plan.nodes.length });
  }
}

// 2つの状態の時刻・位置・速度がすべて厳密に一致するか。
function sameState(a: KinematicState, b: KinematicState): boolean {
  return a.t === b.t && sameVec(a.r, b.r) && sameVec(a.v, b.v);
}

// 2 軌道の近さ判定(長半径・離心率・軌道面)
function orbitalElementsClose(a: OrbitalElements, b: OrbitalElements): boolean {
  if (!isFinite(a.a) || !isFinite(b.a) || a.a <= 0 || b.a <= 0) return false;
  const planeCos = Math.max(-1, Math.min(1, dot(a.hHat, b.hHat)));
  return (
    Math.abs(a.a - b.a) / b.a < NODE_TOL_SMA &&
    Math.abs(a.e - b.e) < NODE_TOL_ECC &&
    (Math.acos(planeCos) * 180) / Math.PI < NODE_TOL_PLANE_DEG
  );
}
