// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 KinematicState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。計画軌道の計算・キャッシュは持たない。
import {
  deserializeKinematicState, type KinematicState, type SerializedKinematicState,
} from '../../physics/kinematic-state';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { orbitalElementsOf } from '../../physics/elements';

// 計画をどう実行するか。'off': ノードを消化しない。
// 'instant': ノード時刻ちょうどで絶対状態へ乗り移る(自動実行)。
export type PlanExecutionMode = 'off' | 'instant';

export interface SerializedPlan {
  readonly anchor: SerializedKinematicState;
  readonly nodes: SerializedKinematicState[];
}

// ノード実行時刻の何秒前から「実行の窓」とみなすか [s]。噴射準備の通知・達成判定の開始・
// 自動ワープの解除がこの1点を共有する。
export const NODE_APPROACH_LEAD = 10;

// segmentDurationFrom が要求する表示窓の部分だけを切り出した形。
export interface DisplayDurationSource {
  durationSec(referencePeriod: number): number;
}

// 起点状態を最も強く引く天体まわりの解析軌道の公転周期。
// 有限な周期が求まらなければ(双曲線軌道など)NaN。
export function orbitPeriodOf(
  state: KinematicState, celestialBodies: readonly CelestialBody[], pivot: number,
): number {
  const center = strongestAttractor(state.r, celestialBodies, pivot);
  return orbitalElementsOf(state, center, pivot)?.period ?? NaN;
}

// ある状態を起点に描かれる区間の長さ [s]。その状態の遷移後軌道の公転周期を参照期間として
// 表示期間を引く。ノードを置ける時刻範囲(nodeTimeRange)と描かれる
// 折れ線の長さ(plan-path.ts の buildSegments)は必ずこの値を共有する — 両者が
// 別々に定義すると描画範囲とノード配置可能範囲がずれる。
export function segmentDurationFrom(
  state0: KinematicState,
  celestialBodies: readonly CelestialBody[],
  displayDuration: DisplayDurationSource,
): number {
  return displayDuration.durationSec(orbitPeriodOf(state0, celestialBodies, state0.t));
}

// ノードを置ける実行時刻の範囲。
export interface TimeRange {
  min: number;
  max: number;
}

// 計画折れ線の材料 — 起点1つとノード列。ノード列は空でもよい: 1件目のノードを置く前は、
// 起点だけの1区間になる。
export interface PlanData {
  readonly anchor: KinematicState;
  readonly nodes: readonly KinematicState[];
}

// ノードが1件も無いことを示す共有の空配列。毎回新しい配列を返すと、
// これを読む側の参照比較が常に外れる。
const NO_NODES: readonly KinematicState[] = [];

export class Plan {
  // data は起点とノード列。PlanData に「null ⟺ ノードが1件も無い」を足したもので、その対応を保つのが
  // Plan の責務。ノードが1件も無い計画の起点は自機の現在状態そのものなので、Plan は持たない。
  private constructor(private data: { anchor: KinematicState; nodes: KinematicState[] } | null = null) {}

  // ノードが1件も無い計画を作る。
  public static create(): Plan {
    return new Plan();
  }

  // 直列化した計画を復元する。ノードは addNode と同じ規則で順に置き直すので、起点の時刻以前の
  // ノード(droppedNodeCount が数える)は捨てられ、実行時刻の戻ったノードはそれ以降を置き換える。
  public static deserialize(serialized: SerializedPlan): Plan {
    const anchor = deserializeKinematicState(serialized.anchor);
    const nodes: KinematicState[] = [];
    for (const node of serialized.nodes) {
      if (node.t <= anchor.t) continue;
      nodes.length = nodes.filter((kept) => kept.t < node.t).length;
      nodes.push(deserializeKinematicState(node));
    }
    return new Plan(nodes.length > 0 ? { anchor, nodes } : null);
  }

  // 直列化した計画のうち、起点の時刻以前にあって deserialize が捨てるノードの数。
  public static droppedNodeCount(serialized: SerializedPlan): number {
    return serialized.nodes.filter((node) => node.t <= serialized.anchor.t).length;
  }

  // 凍結した起点とノード列の直列化。ノードが1件も無ければ null — そのときの起点は自機そのもの
  // なので、直列化すべき計画は存在しない。
  public serialize(): SerializedPlan | null {
    if (!this.data) return null;
    const { anchor, nodes } = this.data;
    return {
      anchor: { t: anchor.t, r: { ...anchor.r }, v: { ...anchor.v } },
      nodes: nodes.map((n) => ({ t: n.t, r: { ...n.r }, v: { ...n.v } })),
    };
  }

  // ノード列を実行時刻順で返す。ノードが1件も無ければ空。
  public get nodes(): readonly KinematicState[] {
    return this.data?.nodes ?? NO_NODES;
  }

  // 計画の起点。ノードが1件も無いあいだの起点は fallback — その計画は自機の現在軌道
  // そのものなので、起点はここで自機から借りる。この対応付けを外へ出さないために、
  // 起点は常にこれを通して読む。
  public anchorOr(fallback: KinematicState): KinematicState {
    return this.data?.anchor ?? fallback;
  }

  // 折れ線の材料。起点の借り方は anchorOr と同じ。
  public displayData(shipState: KinematicState): PlanData {
    return this.data ?? { anchor: shipState, nodes: NO_NODES };
  }

  // 最初に実行されるノードを返す。ノードが無ければ undefined。
  public firstNode(): KinematicState | undefined {
    return this.data?.nodes[0];
  }

  // 起点を anchor とする計画で、実行時刻 t のノードが実行時刻順で何番目になるか。起点の時刻
  // 以前は計画の外なので置けず -1 を返す — そこへ置くと nodeTimeRange(0) の下限を割り、
  // 「ノードは直前の状態より後」という不変条件が最初のノードで破れる。anchor には、置いた後に
  // 効く起点(anchorOr で借りたもの)を渡す。
  public nodeIndexFor(t: number, anchor: KinematicState): number {
    if (t <= anchor.t) return -1;
    return this.data?.nodes.filter((node) => node.t < t).length ?? 0;
  }

  // 噴射直後の絶対状態としてノードを追加し、その index を返す。実行時刻順の挿入位置より
  // 後ろのノードは破棄されるので、追加したノードが常に末尾になる。ノードがまだ1件も無ければ
  // from を起点として凍結する。置けない実行時刻なら何もせず -1 を返す。
  public addNode(postState: KinematicState, from: KinematicState): number {
    const data = this.data;
    const idx = this.nodeIndexFor(postState.t, this.anchorOr(from));
    if (idx < 0) return idx;
    // 1件目は起点の凍結を伴う。
    if (!data) {
      this.data = { anchor: from, nodes: [postState] };
      return idx;
    }
    // 2件目以降は挿入位置から先を捨てて積み直す。
    data.nodes.length = idx;
    data.nodes.push(postState);
    return idx;
  }

  // idx 番目のノードを下流ノードごと削除する。範囲外なら何もしない。1件も残らなければ
  // 起点ごと捨てる。
  public removeNode(idx: number): void {
    const data = this.data;
    if (!data?.nodes[idx]) return;
    if (idx === 0) this.data = null;
    else data.nodes.length = idx;
  }

  // 実行時刻が t 以前のノードを実行済みとして取り除き、取り除いた件数を返す。
  // 以降の計画は actualState — ノードが目指した理想値ではなく、実際にそこへ到達した状態 —
  // を起点に描かれる。動力飛行のバーンは計画どおりの Δv を達成しきれないことがあり、その
  // 誤差は消さずに以降の計画へ残さなければ、計画と実際の乖離が画面から読めなくなる。
  // 1件も残らなければ起点ごと捨てる。
  public consumeNodesUpTo(t: number, actualState: KinematicState): number {
    const data = this.data;
    if (!data) return 0;
    const nodes = data.nodes;
    let dropped = 0;
    while (nodes[dropped] && nodes[dropped]!.t <= t) dropped++;
    if (dropped === 0) return 0;
    // actualState の時刻は t より後になりうる(消化を知るのは、その時刻を過ぎてからになる)。
    // 残るノードを追い越したまま起点に据えると「ノードは直前の状態より後」という不変条件が
    // 破れ、先頭区間が負の長さになる。追い越した先のノードも消化済みとして扱う。
    while (nodes[dropped] && nodes[dropped]!.t <= actualState.t) dropped++;
    nodes.splice(0, dropped);
    this.data = nodes.length > 0 ? { anchor: actualState, nodes } : null;
    return dropped;
  }

  // 全ノードを削除する。
  public clear(): void {
    this.data = null;
  }

  // idx 番目のノードを置ける実行時刻の範囲。直前の状態(前のノード、無ければ起点)の時刻から、
  // その状態を起点に描かれている末尾区間の折れ線が尽きるところまで。起点の借り方は anchorOr と同じ。
  public nodeTimeRange(
    idx: number, from: KinematicState, celestialBodies: readonly CelestialBody[], displayDuration: DisplayDurationSource,
  ): TimeRange {
    const prev = this.data?.nodes[idx - 1] ?? this.anchorOr(from);

    return { min: prev.t, max: prev.t + segmentDurationFrom(prev, celestialBodies, displayDuration) };
  }

  // idx 番目のノードを新しい実行後状態へ差し替え、下流ノードを破棄する。範囲外なら何もしない。
  // 時刻を動かす場合、postState.t は nodeTimeRange(idx) の範囲内であること。
  public replaceNode(idx: number, postState: KinematicState): void {
    const data = this.data;
    if (!data?.nodes[idx]) return;
    // 下流ノードは上流ノードの実行後状態を起点に凍結した絶対状態なので、上流が動いた時点で
    // 意味を失う。
    data.nodes.length = idx + 1;
    data.nodes[idx] = postState;
  }
}
