// 軌道計画(ノード列)とその起点アンカー = 純 corners データ。マップモードの有無に
// 関わらず存在するデータで、PlanEditor が所有し、実施(plan-guide.ts)へは Game 経由で
// 注入する。ノードの追加・削除・並べ替え・編集は必ずこのクラスのメソッド経由で行う。
// 予測軌道の計算・キャッシュは持たない — それは plan 隣接の PlanTrajectory(B-2)と各 arc の
// PredictedLine(B-1)が per-arc に司る(入力変化検出でノード編集を吸収するので dirty フラグは不要)。
//
// データモデル: アンカーもノードも 1 個の OrbitState(時刻付き状態ベクトル)で表す。
//  - anchor: 予定 player の起点(frozen アンカー)。計画が空の間だけ trackAnchor() で自機の
//    現在状態へ追従し、最初のノードを置いた瞬間に凍結される(以降は手動クリアで空へ戻すまで
//    動かない)。予測はこのアンカー + 凍結ノードだけの純関数で、player.live には依存しない。
//  - nodes: 各曲がり角の「実行(噴射)直後の絶対状態」(時刻・r・v とも凍結)。相対 Δv では
//    なく実行後の状態そのものを正データとして持つ — r の再計算は予測依存かつ積分誤差を
//    伴い、軽微な導出値ではないため。Δv は導出値(= ノードの v − 到達時の速度)。
//
// 上流ノードを編集すると下流ノードの凍結状態は無効になるため、編集メソッドは編集ノード
// より後(時刻が後)のノードを破棄する(千切れさせない = 削除。再スナップはしない)。
//
// 「どのノードが選択中か」という選択状態そのものは持たない(それは PlanEditor の責務)。
// ただし配列の並び替え・削除に耐えられるよう、ノードには 1 対 1 で単調増加の内部 ID を
// 割り当てて公開する(nodeIdAt/indexOfNodeId)。選択の正本を index ではなく ID で持てば、
// consumeFirstNode() などで配列が動いても選択がずれない。
import { orbitState, OrbitState } from '../../physics/orbital';
import { Vec3, add, v3 } from '../../physics/vec3';

export class Plan {
  private _nodes: OrbitState[] = [];
  // _nodes と同じ並び・同じ長さを保つ ID 列。ノードの状態を差し替えるだけの編集
  // (retimeNode/applyNodeDv)では ID を変えない = 同じスロットは同じノードとみなす。
  private _nodeIds: number[] = [];
  private nextNodeId = 1;
  private _anchor: OrbitState = orbitState(0, v3(), v3());

  get nodes(): readonly OrbitState[] {
    return this._nodes;
  }

  // 予定 player の起点(frozen アンカー)。predict はこれと nodes だけの純関数。
  get anchor(): OrbitState {
    return this._anchor;
  }

  firstNode(): OrbitState | undefined {
    return this._nodes[0];
  }

  // 計画が空の間だけ、予定 player の起点を現在の自機状態へ追従させる(editor が設計時に
  // player.live を読む唯一の経路)。最初のノードを置いてアンカーが凍結されたら no-op に
  // なり、以降 predict は player.live 非依存になる。clear() で空へ戻すと追従を再開する。
  trackAnchor(state: OrbitState): void {
    if (this._nodes.length > 0) return;
    this._anchor = state;
  }

  addNode(postState: OrbitState): number {
    const id = this.nextNodeId++;
    this._nodes.push(postState);
    this._nodeIds.push(id);
    this.sortByTime();
    return this._nodes.indexOf(postState);
  }

  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.splice(idx, 1);
    this._nodeIds.splice(idx, 1);
  }

  // 直近ノード(達成済み)を1件消費する。plan-guide.ts の達成判定からのみ呼ぶ。
  consumeFirstNode(): void {
    this._nodes.shift();
    this._nodeIds.shift();
  }

  clear(): void {
    if (this._nodes.length === 0) return;
    this._nodes = [];
    this._nodeIds = [];
  }

  // ノードを新しい実行後状態(時刻込み)へ移す(リタイム)。時刻順に再ソートし、移動後の
  // ノードより下流を破棄する。戻り値は再ソート後の index。スロット(=ID)は変えない。
  retimeNode(idx: number, postState: OrbitState): number {
    if (!this._nodes[idx]) return idx;
    this._nodes[idx] = postState;
    this.sortByTime();
    const newIdx = this._nodes.indexOf(postState);
    this._nodes.length = newIdx + 1; // 下流ノードを破棄(千切れさせない = 削除)
    this._nodeIds.length = newIdx + 1;
    return newIdx;
  }

  // 選択中ノードの実行後速度へワールド Δv を加える(pro/nrm/rad → world の変換は editor)。
  // 上流編集なので下流ノードを破棄する。スロット(=ID)は変えない。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node || (dvWorld.x === 0 && dvWorld.y === 0 && dvWorld.z === 0)) return;
    this._nodes[idx] = orbitState(node.t, node.r, add(node.v, dvWorld));
    if (idx < this._nodes.length - 1) {
      this._nodes.length = idx + 1;
      this._nodeIds.length = idx + 1;
    }
  }

  // idx 番目のノードの ID(選択状態の正本として editor が保持する)。範囲外なら null。
  nodeIdAt(idx: number): number | null {
    return idx >= 0 && idx < this._nodeIds.length ? this._nodeIds[idx]! : null;
  }

  // ID から現在の index を逆引きする(配列の並び替え・削除後も選択を追跡できる)。
  // 該当ノードが既に消えていれば null。
  indexOfNodeId(id: number): number | null {
    const idx = this._nodeIds.indexOf(id);
    return idx >= 0 ? idx : null;
  }

  // _nodes を時刻順に整列し、_nodeIds を同じ並び替えに追随させる(ペアで動かす)。
  private sortByTime(): void {
    const order = this._nodes.map((_, i) => i);
    order.sort((a, b) => this._nodes[a]!.t - this._nodes[b]!.t);
    this._nodes = order.map((i) => this._nodes[i]!);
    this._nodeIds = order.map((i) => this._nodeIds[i]!);
  }
}
