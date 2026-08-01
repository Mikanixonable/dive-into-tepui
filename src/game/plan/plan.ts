// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 OrbitState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。計画軌道の計算・キャッシュは持たない。
import { elementsFromState, orbitState, OrbitState } from '../../physics/orbital';
import { Vec3, add, v3 } from '../../physics/vec3';
import * as C from '../const';

interface Node {
  state: OrbitState;
  id: number;
}

// 計画の1区間が受け持てる時間長 = 起点状態の解析軌道1周期。周期を持たない軌道(双曲線・
// 放物線)では APERIODIC_ARC_DURATION。
export function orbitPeriodOf(state: OrbitState): number {
  const period = elementsFromState(state.r, state.v)?.period;
  return period !== undefined && isFinite(period) && period > 0 ? period : C.APERIODIC_ARC_DURATION;
}

// ノードを置ける実行時刻の範囲。
export interface TimeRange {
  min: number;
  max: number;
}

export class Plan {
  private _nodes: Node[] = [];
  private nextNodeId = 1;
  private _anchor: OrbitState = orbitState(0, v3(), v3());

  // ノード列を実行時刻順で返す。
  get nodes(): readonly OrbitState[] {
    return this._nodes.map(node => node.state);
  }

  // 計画の起点状態を返す。
  get anchor(): OrbitState {
    return this._anchor;
  }

  // idx より後ろのノードをすべて捨てる。
  private deleteFollowingNodes(idx: number): void {
    if (idx < this._nodes.length - 1) {
      this._nodes.length = idx + 1;
    }
  }

  // 最初に実行されるノードを返す。ノードが無ければ undefined。
  firstNode(): OrbitState | undefined {
    return this._nodes[0]?.state;
  }

  // 計画が空の間だけアンカーを現在状態へ追従させる。最初のノードを置くと凍結。
  trackAnchor(state: OrbitState): void {
    if (this._nodes.length > 0) return;
    this._anchor = state;
  }

  // 噴射直後の絶対状態としてノードを追加し、時刻順にソートした後の index を返す。
  addNode(postState: OrbitState): number {
    const id = this.nextNodeId++;
    this._nodes.push({state: postState, id});
    this.sortByTime();
    const idx = this._nodes.findIndex(node => node.id === id);
    this.deleteFollowingNodes(idx);
    this.debugLogNodes();
    return idx;
  }

  // idx 番目のノードを下流ノードごと削除する。範囲外なら何もしない。
  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.length = idx;
    this.debugLogNodes();
  }

  // 最初のノードを実行済みとして取り除く。
  consumeFirstNode(): void {
    this._nodes.shift();
    this.debugLogNodes();
  }

  // 全ノードを削除する。
  clear(): void {
    if (this._nodes.length === 0) return;
    this._nodes = [];
    this.debugLogNodes();
  }

  // idx 番目のノードを置ける実行時刻の範囲。直前の状態(前のノード、無ければアンカー)の時刻から
  // その軌道1周期ぶんまで。これを超えると区間が自分自身に重なり、折れ線上の1点が何周目の
  // どこなのかを指し分けられなくなる。
  nodeTimeRange(idx: number): TimeRange {
    const prev = this._nodes[idx - 1]?.state ?? this._anchor;
    return { min: prev.t, max: prev.t + orbitPeriodOf(prev) };
  }

  // ノードを新しい実行後状態へ移し、下流ノードを破棄する。時刻は nodeTimeRange の範囲内であること。
  retimeNode(idx: number, postState: OrbitState): void {
    if (!this._nodes[idx]) return;
    this.deleteFollowingNodes(idx);
    this._nodes[idx]!.state = postState;
    this.debugLogNodes();
  }

  // 選択中ノードの実行後速度へワールド Δv を加え、下流ノードを破棄する。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node || (dvWorld.x === 0 && dvWorld.y === 0 && dvWorld.z === 0)) return;
    this._nodes[idx]!.state = orbitState(node.state.t, node.state.r, add(node.state.v, dvWorld));
    this.deleteFollowingNodes(idx);
    this.debugLogNodes();
  }

  // デバッグ用にノード列を出力する。配列はこの後も破壊的に書き換わるので複製を渡す。
  private debugLogNodes(): void {
    console.log([...this._nodes]);
  }

  // idx 番目のノードの ID。範囲外なら null。
  nodeIdAt(idx: number): number | null {
    return idx >= 0 && idx < this._nodes.length ? this._nodes[idx]!.id : null;
  }

  // ID から現在の index を逆引きする。該当ノードが無ければ null。
  indexOfNodeId(id: number): number | null {
    const idx = this._nodes.findIndex(node => node.id === id);
    return idx >= 0 ? idx : null;
  }

  // ノードを実行時刻順に並べ替える。
  private sortByTime(): void {
    this._nodes.sort((a, b) => a.state.t - b.state.t);
  }
}
