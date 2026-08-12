// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 KinematicState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。計画軌道の計算・キャッシュは持たない。
import { kinematicState, KinematicState } from '../../physics/kinematic-state';
import { Vec3, add, v3 } from '../../physics/vec3';
import { Attractor, orbitalElementsOf, strongestAttractor } from '../../physics/attractor';
import type { Ephemeris } from '../../physics/ephemeris';

// segmentDurationFrom が要求する表示窓の部分だけを切り出した形。
export interface DisplayDurationSource {
  durationSec(referencePeriod: number): number;
}

// 起点状態を最も強く引く天体まわりの解析軌道の公転周期。
// 有限な周期が求まらなければ(双曲線軌道など)NaN。
export function orbitPeriodOf(state: KinematicState, attractors: readonly Attractor[]): number {
  const center = strongestAttractor(state.r, attractors);
  return orbitalElementsOf(state, center)?.period ?? NaN;
}

// ある状態を起点に描かれる区間の長さ [s]。その状態の遷移後軌道の公転周期を参照期間として
// 表示期間を引く。ノードを置ける時刻範囲(nodeTimeRange)と描かれる
// 折れ線の長さ(plan-path.ts の buildSegments)は必ずこの値を共有する — 両者が
// 別々に定義すると描画範囲とノード配置可能範囲がずれる。
export function segmentDurationFrom(
  state0: KinematicState,
  attractors: readonly Attractor[],
  displayDuration: DisplayDurationSource,
): number {
  return displayDuration.durationSec(orbitPeriodOf(state0, attractors));
}

// ノードを置ける実行時刻の範囲。
export interface TimeRange {
  min: number;
  max: number;
}

export class Plan {
  private _nodes: KinematicState[] = [];
  private _anchor: KinematicState = kinematicState(0, v3(), v3());
  private _revision = 0;

  // 編集でノード列またはアンカーが実際に変化するたびに増える世代値。空の計画のアンカー追従は
  // 編集ではないので変化しない。
  get revision(): number {
    return this._revision;
  }

  // ノード列を実行時刻順で返す。
  get nodes(): readonly KinematicState[] {
    return this._nodes;
  }

  // 計画の起点状態を返す。
  get anchor(): KinematicState {
    return this._anchor;
  }

  // idx より後ろのノードをすべて捨てる。下流ノードは上流ノードの実行後状態を起点に凍結した
  // 絶対状態なので、上流が動いた時点で意味を失う。編集は必ずこれを通す。
  private truncateAfter(idx: number): void {
    this._nodes.length = idx + 1;
  }

  // 最初に実行されるノードを返す。ノードが無ければ undefined。
  firstNode(): KinematicState | undefined {
    return this._nodes[0];
  }

  // 計画が空の間だけアンカーを現在状態へ追従させる。最初のノードを置くと凍結。
  trackAnchor(state: KinematicState): void {
    if (this._nodes.length > 0) return;
    this._anchor = state;
  }

  // 噴射直後の絶対状態としてノードを追加し、その index を返す。実行時刻順の挿入位置より
  // 後ろのノードは破棄されるので、追加したノードが常に末尾になる。アンカー時刻以前は
  // 計画の外なので受け付けず -1 を返す — そこへ置くと nodeTimeRange(0) の下限を割り、
  // 「ノードは直前の状態より後」という不変条件が最初のノードで破れる。
  addNode(postState: KinematicState): number {
    if (postState.t <= this._anchor.t) return -1;
    const idx = this._nodes.filter((node) => node.t < postState.t).length;
    this._nodes.length = idx;
    this._nodes.push(postState);
    this._revision++;
    return idx;
  }

  // idx 番目のノードを下流ノードごと削除する。範囲外なら何もしない。
  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.length = idx;
    this._revision++;
  }

  // 実行時刻が t 以前のノードを実行済みとして取り除き、取り除いた件数を返す。
  // 以降の計画は actualState — ノードが目指した理想値ではなく、実際にそこへ到達した状態 —
  // を起点に描かれる。動力飛行のバーンは計画どおりの Δv を達成しきれないことがあり、その
  // 誤差は消さずに以降の計画へ残さなければ、計画と実際の乖離が画面から読めなくなる。
  consumeNodesUpTo(t: number, actualState: KinematicState): number {
    let dropped = 0;
    while (this._nodes[dropped] && this._nodes[dropped]!.t <= t) dropped++;
    if (dropped === 0) return 0;
    // actualState の時刻は t より後になりうる(消化を知るのは、その時刻を過ぎてからになる)。
    // 残るノードを追い越したまま起点に据えると「ノードは直前の状態より後」という不変条件が
    // 破れ、先頭区間が負の長さになる。追い越した先のノードも消化済みとして扱う。
    while (this._nodes[dropped] && this._nodes[dropped]!.t <= actualState.t) dropped++;
    this._nodes.splice(0, dropped);
    this._anchor = actualState;
    this._revision++;
    return dropped;
  }

  // 全ノードを削除する。
  clear(): void {
    if (this._nodes.length === 0) return;
    this._nodes.length = 0;
    this._revision++;
  }

  // idx 番目のノードを置ける実行時刻の範囲。直前の状態(前のノード、無ければアンカー)の時刻から、
  // その状態を起点に描かれている末尾区間の折れ線が尽きるところまで。
  nodeTimeRange(idx: number, ephemeris: Ephemeris, displayDuration: DisplayDurationSource): TimeRange {
    const prev = this._nodes[idx - 1] ?? this._anchor;
    const attractors = ephemeris.attractorsAt(prev.t);
    return { min: prev.t, max: prev.t + segmentDurationFrom(prev, attractors, displayDuration) };
  }

  // idx 番目のノードを新しい実行後状態へ差し替え、下流ノードを破棄して、置いたノードを返す。
  // 時刻を動かす場合、postState.t は nodeTimeRange(idx) の範囲内であること。
  // ノードは不変オブジェクトなので編集は必ず別オブジェクトへの差し替えになる — 参照で
  // ノードを追っている呼び出し側が追随できるよう、置いた結果を返す。
  replaceNode(idx: number, postState: KinematicState): KinematicState | null {
    if (!this._nodes[idx]) return null;
    this.truncateAfter(idx);
    this._nodes[idx] = postState;
    this._revision++;
    return postState;
  }

  // idx 番目のノードの実行後速度へワールド Δv を加え、下流ノードを破棄して、置いたノードを返す。
  applyNodeDv(idx: number, dvWorld: Vec3): KinematicState | null {
    const node = this._nodes[idx];
    if (!node) return null;
    this.truncateAfter(idx);
    return this.replaceNode(idx, kinematicState(node.t, node.r, add(node.v, dvWorld)));
  }
}
