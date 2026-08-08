// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 OrbitState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。計画軌道の計算・キャッシュは持たない。
import { orbitState, OrbitState } from '../../physics/orbital-state';
import { Vec3, add, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Attractor, elementsAround, strongestAttractor } from '../../physics/attractor';
import type { Ephemeris } from '../../physics/ephemeris';

// segmentDurationFrom が要求する DisplayTimeManager の部分だけを切り出した形。
export interface DisplayDurationSource {
  durationSec(referencePeriod: number): number;
}

// 起点状態を最も強く引く天体まわりの解析軌道の公転周期。
// 有限な周期が求まらなければ(双曲線軌道など)APERIODIC_ARC_DURATION。
export function orbitPeriodOf(state: OrbitState, bodies: readonly Attractor[]): number {
  const center = strongestAttractor(state.r, bodies);
  const period = elementsAround(state, center)?.period ?? NaN;
  return isFinite(period) && period > 0 ? period : C.APERIODIC_ARC_DURATION;
}

// ある状態を起点に描かれる区間の長さ [s]。その状態の遷移後軌道の公転周期を参照期間として
// DisplayTimeManager の表示期間を引く。ノードを置ける時刻範囲(nodeTimeRange)と描かれる
// 折れ線の長さ(plan-trajectory.ts の buildSegments)は必ずこの値を共有する — 両者が
// 別々に定義すると描画範囲とノード配置可能範囲がずれる。
export function segmentDurationFrom(
  state0: OrbitState,
  bodies: readonly Attractor[],
  displayDuration: DisplayDurationSource,
): number {
  return displayDuration.durationSec(orbitPeriodOf(state0, bodies));
}

// ノードを置ける実行時刻の範囲。
export interface TimeRange {
  min: number;
  max: number;
}

export class Plan {
  private _nodes: OrbitState[] = [];
  private _anchor: OrbitState = orbitState(0, v3(), v3());

  // ノード列を実行時刻順で返す。
  get nodes(): readonly OrbitState[] {
    return this._nodes;
  }

  // 計画の起点状態を返す。
  get anchor(): OrbitState {
    return this._anchor;
  }

  // idx より後ろのノードをすべて捨てる。下流ノードは上流ノードの実行後状態を起点に凍結した
  // 絶対状態なので、上流が動いた時点で意味を失う。編集は必ずこれを通す。
  private deleteFollowingNodes(idx: number): void {
    this._nodes.length = idx + 1;
  }

  // 最初に実行されるノードを返す。ノードが無ければ undefined。
  firstNode(): OrbitState | undefined {
    return this._nodes[0];
  }

  // 計画が空の間だけアンカーを現在状態へ追従させる。最初のノードを置くと凍結。
  trackAnchor(state: OrbitState): void {
    if (this._nodes.length > 0) return;
    this._anchor = state;
  }

  // 噴射直後の絶対状態としてノードを追加し、その index を返す。実行時刻順の挿入位置より
  // 後ろのノードは破棄されるので、追加したノードが常に末尾になる。
  addNode(postState: OrbitState): number {
    const idx = this._nodes.filter((node) => node.t < postState.t).length;
    this._nodes.length = idx;
    this._nodes.push(postState);
    return idx;
  }

  // idx 番目のノードを下流ノードごと削除する。範囲外なら何もしない。
  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.length = idx;
  }

  // 実行時刻が t 以前のノードを実行済みとして取り除き、最後に取り除いたノードを新しい起点に据えて
  // 返す。取り除くものが無ければ null。
  dropNodesBefore(t: number): OrbitState | null {
    let dropped = 0;
    while (this._nodes[dropped] && this._nodes[dropped]!.t <= t) dropped++;
    if (dropped === 0) return null;
    this._anchor = this._nodes[dropped - 1]!;
    this._nodes.splice(0, dropped);
    return this._anchor;
  }

  // 全ノードを削除する。
  clear(): void {
    this._nodes.length = 0;
  }

  // idx 番目のノードを置ける実行時刻の範囲。直前の状態(前のノード、無ければアンカー)の時刻から、
  // その状態を起点に描かれている末尾区間の折れ線が尽きるところまで。
  nodeTimeRange(idx: number, ephemeris: Ephemeris, displayDuration: DisplayDurationSource): TimeRange {
    const prev = this._nodes[idx - 1] ?? this._anchor;
    const bodies = ephemeris.attractorsAt(prev.t);
    return { min: prev.t, max: prev.t + segmentDurationFrom(prev, bodies, displayDuration) };
  }

  // ノードを新しい実行後状態へ移し、下流ノードを破棄する。時刻は nodeTimeRange の範囲内であること。
  retimeNode(idx: number, postState: OrbitState): void {
    if (!this._nodes[idx]) return;
    this.deleteFollowingNodes(idx);
    this._nodes[idx] = postState;
  }

  // idx 番目のノードの実行後速度へワールド Δv を加え、下流ノードを破棄する。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node) return;
    this.deleteFollowingNodes(idx);
    this._nodes[idx] = orbitState(node.t, node.r, add(node.v, dvWorld));
  }
}
