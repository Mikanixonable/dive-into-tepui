// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 KinematicState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。計画軌道の計算・キャッシュは持たない。
import { kinematicState, KinematicState } from '../../physics/kinematic-state';
import { Vec3, add } from '../../physics/vec3';
import { CelestialBody, orbitalElementsOf, strongestAttractor } from '../../physics/celestial-body';
import type { Ephemeris } from '../../physics/ephemeris';

// segmentDurationFrom が要求する表示窓の部分だけを切り出した形。
export interface DisplayDurationSource {
  durationSec(referencePeriod: number): number;
}

// 起点状態を最も強く引く天体まわりの解析軌道の公転周期。
// 有限な周期が求まらなければ(双曲線軌道など)NaN。
export function orbitPeriodOf(state: KinematicState, celestialBodies: readonly CelestialBody[]): number {
  const center = strongestAttractor(state.r, celestialBodies);
  return orbitalElementsOf(state, center)?.period ?? NaN;
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
  return displayDuration.durationSec(orbitPeriodOf(state0, celestialBodies));
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
  // 起点とノード列。PlanData に「null ⟺ ノードが1件も無い」を足したもので、その対応を保つのが
  // Plan の責務。ノードが1件も無い計画の起点は自機の現在状態そのものなので、Plan は持たない。
  private data: { anchor: KinematicState; nodes: KinematicState[] } | null = null;
  private _revision = 0;

  // 編集でノード列または起点が実際に変化するたびに増える世代値。data の外に置く —
  // 空になってから作り直しても単調に増え続けなければ、キャッシュ鍵として衝突する。
  get revision(): number {
    return this._revision;
  }

  // ノード列を実行時刻順で返す。ノードが1件も無ければ空。
  get nodes(): readonly KinematicState[] {
    return this.data?.nodes ?? NO_NODES;
  }

  // 計画の起点。ノードが1件も無いあいだの起点は fallback — その計画は自機の現在軌道
  // そのものなので、起点はここで自機から借りる。この対応付けを外へ出さないために、
  // 起点は常にこれを通して読む。
  anchorOr(fallback: KinematicState): KinematicState {
    return this.data?.anchor ?? fallback;
  }

  // 折れ線の材料。起点の借り方は anchorOr と同じ。
  displayData(shipState: KinematicState): PlanData {
    return this.data ?? { anchor: shipState, nodes: NO_NODES };
  }

  // 凍結済みの起点とノード列。ノードが1件も無ければ null — そのときの起点は自機そのものなので、
  // 保存すべき計画は存在しない。
  frozenData(): PlanData | null {
    return this.data;
  }

  // 最初に実行されるノードを返す。ノードが無ければ undefined。
  firstNode(): KinematicState | undefined {
    return this.data?.nodes[0];
  }

  // 噴射直後の絶対状態としてノードを追加し、その index を返す。実行時刻順の挿入位置より
  // 後ろのノードは破棄されるので、追加したノードが常に末尾になる。ノードがまだ1件も無ければ
  // from を起点として凍結する。起点の時刻以前は計画の外なので受け付けず -1 を返す — そこへ
  // 置くと nodeTimeRange(0) の下限を割り、「ノードは直前の状態より後」という不変条件が
  // 最初のノードで破れる。
  addNode(postState: KinematicState, from: KinematicState): number {
    const data = this.data;
    if (postState.t <= this.anchorOr(from).t) return -1;
    this._revision++;
    if (!data) {
      this.data = { anchor: from, nodes: [postState] };
      return 0;
    }
    const idx = data.nodes.filter((node) => node.t < postState.t).length;
    data.nodes.length = idx;
    data.nodes.push(postState);
    return idx;
  }

  // idx 番目のノードを下流ノードごと削除する。範囲外なら何もしない。1件も残らなければ
  // 起点ごと捨てる。
  removeNode(idx: number): void {
    const data = this.data;
    if (!data?.nodes[idx]) return;
    if (idx === 0) this.data = null;
    else data.nodes.length = idx;
    this._revision++;
  }

  // 実行時刻が t 以前のノードを実行済みとして取り除き、取り除いた件数を返す。
  // 以降の計画は actualState — ノードが目指した理想値ではなく、実際にそこへ到達した状態 —
  // を起点に描かれる。動力飛行のバーンは計画どおりの Δv を達成しきれないことがあり、その
  // 誤差は消さずに以降の計画へ残さなければ、計画と実際の乖離が画面から読めなくなる。
  // 1件も残らなければ起点ごと捨てる。
  consumeNodesUpTo(t: number, actualState: KinematicState): number {
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
    this._revision++;
    return dropped;
  }

  // 全ノードを削除する。
  clear(): void {
    if (!this.data) return;
    this.data = null;
    this._revision++;
  }

  // idx 番目のノードを置ける実行時刻の範囲。直前の状態(前のノード、無ければ起点)の時刻から、
  // その状態を起点に描かれている末尾区間の折れ線が尽きるところまで。起点の借り方は anchorOr と同じ。
  nodeTimeRange(
    idx: number, from: KinematicState, ephemeris: Ephemeris, displayDuration: DisplayDurationSource,
  ): TimeRange {
    const prev = this.data?.nodes[idx - 1] ?? this.anchorOr(from);
    const celestialBodies = ephemeris.celestialBodiesAt(prev.t);
    return { min: prev.t, max: prev.t + segmentDurationFrom(prev, celestialBodies, displayDuration) };
  }

  // idx 番目のノードを新しい実行後状態へ差し替え、下流ノードを破棄して、置いたノードを返す。
  // 時刻を動かす場合、postState.t は nodeTimeRange(idx) の範囲内であること。
  // ノードは不変オブジェクトなので編集は必ず別オブジェクトへの差し替えになる — 参照で
  // ノードを追っている呼び出し側が追随できるよう、置いた結果を返す。
  replaceNode(idx: number, postState: KinematicState): KinematicState | null {
    const data = this.data;
    if (!data?.nodes[idx]) return null;
    // 下流ノードは上流ノードの実行後状態を起点に凍結した絶対状態なので、上流が動いた時点で
    // 意味を失う。
    data.nodes.length = idx + 1;
    data.nodes[idx] = postState;
    this._revision++;
    return postState;
  }

  // idx 番目のノードの実行後速度へワールド Δv を加え、下流ノードを破棄して、置いたノードを返す。
  applyNodeDv(idx: number, dvWorld: Vec3): KinematicState | null {
    const node = this.data?.nodes[idx];
    if (!node) return null;
    return this.replaceNode(idx, kinematicState(node.t, node.r, add(node.v, dvWorld)));
  }
}
