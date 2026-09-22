// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 KinematicState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。
import {
  deserializeKinematicState, serializeKinematicState, type KinematicState, type SerializedKinematicState,
} from '../../physics/kinematic-state';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { orbitalElementsOf } from '../../physics/elements';

// 計画をどう実行するか。'off': ノードを消化しない。
// 'instant': ノード時刻ちょうどで絶対状態へ乗り移る(自動実行)。
export type PlanExecutionMode = 'off' | 'instant';

export interface SerializedPlan {
  readonly anchor: SerializedKinematicState;
  readonly nodes: readonly SerializedKinematicState[];
}

// ノード実行時刻の何秒前から「実行の窓」とみなすか [s]。
export const NODE_APPROACH_LEAD = 10;

// 参照期間(公転周期)[s] から、表示する期間の長さ [s] を算出するインターフェース。
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

// ある状態を起点に描かれる区間の長さ [s]。その状態の軌道の公転周期を参照期間にした表示期間。
// ノードを置ける時刻範囲と描かれる折れ線の長さは、ずれないよう必ずこの値から決める。
export function segmentDurationFrom(
  state0: KinematicState,
  celestialBodies: readonly CelestialBody[],
  displayDuration: DisplayDurationSource,
): number {
  return displayDuration.durationSec(orbitPeriodOf(state0, celestialBodies, state0.t));
}

// ノードを置ける実行時刻の範囲。
export interface TimeRange {
  readonly min: number;
  readonly max: number;
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
  // data は起点とノード列で、null はノードが1件も無いことを表す(この対応を保つのが Plan の責務)。
  // ノードが無い計画の起点は自機の現在状態そのもので、読むときに借りる。data は外へ渡すので、
  // 変えるときは新しい値へ差し替える。
  private constructor(private data: PlanData | null = null) {}

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
      anchor: serializeKinematicState(anchor),
      nodes: nodes.map(serializeKinematicState),
    };
  }

  // ノード列を実行時刻順で返す。ノードが1件も無ければ空。
  public get nodes(): readonly KinematicState[] {
    return this.data?.nodes ?? NO_NODES;
  }

  // 計画の起点。ノードが1件も無いあいだは自機の現在状態 fallback を起点として借りる。
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

  // 起点を anchor とする計画で、実行時刻 t のノードが実行時刻順で何番目になるか。起点の時刻以前は
  // 「ノードは直前の状態より後」が破れるので置けず -1。anchor には、置いた後に効く起点(anchorOr で
  // 借りたもの)を渡す。
  public nodeIndexFor(t: number, anchor: KinematicState): number {
    if (t <= anchor.t) return -1;
    return this.data?.nodes.filter((node) => node.t < t).length ?? 0;
  }

  // 噴射直後の絶対状態としてノードを追加する。実行時刻順の挿入位置(nodeIndexFor)より後ろのノードは
  // 破棄されるので、追加したノードが常に末尾になる。ノードがまだ1件も無ければ from を起点として
  // 凍結する。置けない実行時刻なら何もしない。
  public addNode(postState: KinematicState, from: KinematicState): void {
    const data = this.data;
    const idx = this.nodeIndexFor(postState.t, this.anchorOr(from));
    if (idx < 0) return;
    // 1件目は起点の凍結を伴う。2件目以降は挿入位置から先を捨てて積み直す。
    this.data = data
      ? { anchor: data.anchor, nodes: [...data.nodes.slice(0, idx), postState] }
      : { anchor: from, nodes: [postState] };
  }

  // idx 番目のノードを下流ノードごと削除する。範囲外なら何もしない。1件も残らなければ
  // 起点ごと捨てる。
  public removeNode(idx: number): void {
    const data = this.data;
    if (!data?.nodes[idx]) return;
    this.data = idx === 0 ? null : { anchor: data.anchor, nodes: data.nodes.slice(0, idx) };
  }

  // 実行時刻が t 以前のノードを実行済みとして取り除く。以降の計画は、ノードが目指した理想値では
  // なく実際に到達した actualState を起点に描く — 噴射の誤差を以降の計画へ残し、計画と実際の乖離を
  // 画面から読めるようにする。1件も残らなければ起点ごと捨てる。
  public consumeNodesUpTo(t: number, actualState: KinematicState): void {
    const data = this.data;
    if (!data) return;
    const nodes = data.nodes;
    let dropped = 0;
    while (nodes[dropped] && nodes[dropped]!.t <= t) dropped++;
    if (dropped === 0) return;
    // actualState は t より後の時刻でありうる。追い越されたノードを残すと「ノードは直前の状態より後」が
    // 破れ、先頭区間が負の長さになるので、それらも消化済みとして扱う。
    while (nodes[dropped] && nodes[dropped]!.t <= actualState.t) dropped++;
    const remaining = nodes.slice(dropped);
    this.data = remaining.length > 0 ? { anchor: actualState, nodes: remaining } : null;
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
    this.data = { anchor: data.anchor, nodes: [...data.nodes.slice(0, idx), postState] };
  }
}
