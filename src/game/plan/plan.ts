// 軌道計画(ノード列)とその起点アンカー。ノードは噴射直後の絶対 OrbitState として凍結し、
// Δv は導出値。上流ノードを編集すると下流を破棄する。予測軌道の計算・キャッシュは持たない。
import { orbitState, OrbitState } from '../../physics/orbital';
import { Vec3, add, v3 } from '../../physics/vec3';

export class Plan {
  private _nodes: OrbitState[] = [];
  private _nodeIds: number[] = [];
  private nextNodeId = 1;
  private _anchor: OrbitState = orbitState(0, v3(), v3());

  // ノード列を実行時刻順で返す。
  get nodes(): readonly OrbitState[] {
    return this._nodes;
  }

  // 計画の起点状態を返す。
  get anchor(): OrbitState {
    return this._anchor;
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

  // 噴射直後の絶対状態としてノードを追加し、時刻順にソートした後の index を返す。
  addNode(postState: OrbitState): number {
    const id = this.nextNodeId++;
    this._nodes.push(postState);
    this._nodeIds.push(id);
    this.sortByTime();
    return this._nodes.indexOf(postState);
  }

  // idx 番目のノードを削除する。範囲外なら何もしない。
  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.splice(idx, 1);
    this._nodeIds.splice(idx, 1);
  }

  // 最初のノードを実行済みとして取り除く。
  consumeFirstNode(): void {
    this._nodes.shift();
    this._nodeIds.shift();
  }

  // 全ノードを削除する。
  clear(): void {
    if (this._nodes.length === 0) return;
    this._nodes = [];
    this._nodeIds = [];
  }

  // ノードを新しい実行後状態へ移し時刻順に再ソート。下流ノードを破棄し、新 index を返す。
  retimeNode(idx: number, postState: OrbitState): number {
    if (!this._nodes[idx]) return idx;
    this._nodes[idx] = postState;
    this.sortByTime();
    const newIdx = this._nodes.indexOf(postState);
    this._nodes.length = newIdx + 1;
    this._nodeIds.length = newIdx + 1;
    return newIdx;
  }

  // 選択中ノードの実行後速度へワールド Δv を加え、下流ノードを破棄する。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node || (dvWorld.x === 0 && dvWorld.y === 0 && dvWorld.z === 0)) return;
    this._nodes[idx] = orbitState(node.t, node.r, add(node.v, dvWorld));
    if (idx < this._nodes.length - 1) {
      this._nodes.length = idx + 1;
      this._nodeIds.length = idx + 1;
    }
  }

  // idx 番目のノードの ID。範囲外なら null。
  nodeIdAt(idx: number): number | null {
    return idx >= 0 && idx < this._nodeIds.length ? this._nodeIds[idx]! : null;
  }

  // ID から現在の index を逆引きする。該当ノードが無ければ null。
  indexOfNodeId(id: number): number | null {
    const idx = this._nodeIds.indexOf(id);
    return idx >= 0 ? idx : null;
  }

  // ノードと ID の対応を保ったまま、両配列を実行時刻順に並べ替える。
  private sortByTime(): void {
    const order = this._nodes.map((_, i) => i);
    order.sort((a, b) => this._nodes[a]!.t - this._nodes[b]!.t);
    this._nodes = order.map((i) => this._nodes[i]!);
    this._nodeIds = order.map((i) => this._nodeIds[i]!);
  }
}
