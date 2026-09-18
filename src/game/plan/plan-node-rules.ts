// 直近ノードの実行の規則: 実行時刻を過ぎたノードの消化と、接近・達成の記録。
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, orbitalElementsOf } from '../../physics/elements';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { dot } from '../../math/vec3';
import type { RunEventSink } from '../run-events';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { NODE_APPROACH_LEAD } from './plan';

// マニューバ達成判定(計画軌道への接近許容)
const NODE_TOL_SMA = 0.02 / 3; // 長半径の相対誤差
const NODE_TOL_ECC = 0.02 / 3; // 離心率差
const NODE_TOL_PLANE_DEG = 2.0 / 3; // 軌道面の角度差 [deg]

// 実行時刻をこれだけ過ぎたノードは計画から落とす [s]。多少の遅れなら噴射できる猶予。
const NODE_EXPIRE_GRACE = 60;

export class PlanNodeRules {
  // 記録済みのノード。ノードは編集のたびに別インスタンスへ置き換わるので、同一性の比較が
  // そのまま「同じノードについて既に記録したか」の判定になる。
  private approachNotified: KinematicState | null = null;
  private achievedNotified: KinematicState | null = null;

  public constructor(private readonly events: RunEventSink) {}

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
    if (this.approachNotified === node) return;
    this.approachNotified = node;
    this.events.record({ kind: 'maneuverNodeApproaching' });
  }

  // 操作対象の軌道が目標軌道に十分近づいていれば達成を記録する。ノードと操作対象で最も強く引く
  // 天体が違えば、要素同士の比較自体が意味を持たないので判定しない。
  private notifyAchieved(
    node: KinematicState, controlled: Controllable,
    celestialBodies: readonly CelestialBody[], pivot: number,
  ): void {
    if (this.achievedNotified === node) return;
    const plan = controlled.plan;
    const controlledCenter = strongestAttractor(
      controlled.motion.state.r, celestialBodies, pivot,
    );
    const nodeCenter = strongestAttractor(node.r, celestialBodies, pivot);
    if (controlledCenter.id !== nodeCenter.id) return;
    const targetEl = orbitalElementsOf(node, nodeCenter, pivot);
    const controlledEl = controlled.motion.orbitalElementsAround(controlledCenter, pivot);
    if (!controlledEl || !targetEl || !orbitalElementsClose(controlledEl, targetEl)) return;
    this.achievedNotified = node;
    // 計画軌道へ到達したノードは、その場で実行済みとして削除する。同時刻のノードが複数あれば
    // まとめて落ちるので、残り件数は落とした後の実数を読む。
    plan.consumeNodesUpTo(node.t, controlled.motion.state);
    this.events.record({ kind: 'maneuverNodeAchieved', remaining: plan.nodes.length });
  }
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
