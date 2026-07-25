// 軌道計画(ノード列)とその起点アンカー = 純 corners データ。マップモードの有無に
// 関わらず存在するデータで、PlanEditor が所有し、実施(plan-guide.ts)へは Game 経由で
// 注入する。ノードの追加・削除・並べ替え・編集は必ずこのクラスのメソッド経由で行う。
// 予測軌道の計算・キャッシュは持たない — それは plan 隣接の PlanTrajectory(B-2)と各 arc の
// PredictedLine(B-1)が per-arc に司る(入力変化検出でノード編集を吸収するので dirty フラグは不要)。
//
// データモデル:
//  - anchor: 予定 player の起点(frozen アンカー)。計画が空の間だけ trackAnchor() で自機の
//    現在状態へ追従し、最初のノードを置いた瞬間に凍結される(以降は手動クリアで空へ戻すまで
//    動かない)。予測はこのアンカー + 凍結ノードだけの純関数で、player.live には依存しない。
//  - nodes: 各曲がり角の {time, 実行後 postState(r,v とも凍結)}。相対 Δv は持たない。
//
// 上流ノードを編集すると下流ノードの凍結状態は無効になるため、編集メソッドは編集ノード
// より後(時刻が後)のノードを破棄する(千切れさせない = 削除。再スナップはしない)。
import { orbitState, OrbitState } from '../../physics/orbital';
import { Vec3, add, clone, v3 } from '../../physics/vec3';

// 軌道計画の「曲がり角」= 実行時刻とその直後の絶対状態(r,v とも凍結)。相対 Δv では
// なく実行後の状態そのものを正データとして持つ — r の再計算は予測依存かつ積分誤差を
// 伴い、軽微な導出値ではないため。Δv は導出値(= postState.v − 到達時の速度)。
export interface PlannedNode {
  time: number; // 実行時刻(絶対 simTime)[s]
  postState: OrbitState; // 実行(噴射)直後の絶対状態
}

export interface PlanAnchor {
  time: number;
  state: OrbitState;
}

export class Plan {
  private _nodes: PlannedNode[] = [];
  private _anchor: PlanAnchor = { time: 0, state: orbitState(v3(), v3()) };

  get nodes(): readonly PlannedNode[] {
    return this._nodes;
  }

  // 予定 player の起点(frozen アンカー)。predict はこれと nodes だけの純関数。
  get anchor(): PlanAnchor {
    return this._anchor;
  }

  firstNode(): PlannedNode | undefined {
    return this._nodes[0];
  }

  // 計画が空の間だけ、予定 player の起点を現在の自機状態へ追従させる(editor が設計時に
  // player.live を読む唯一の経路)。最初のノードを置いてアンカーが凍結されたら no-op に
  // なり、以降 predict は player.live 非依存になる。clear() で空へ戻すと追従を再開する。
  trackAnchor(time: number, state: OrbitState): void {
    if (this._nodes.length > 0) return;
    this._anchor = { time, state: orbitState(clone(state.r), clone(state.v)) };
  }

  addNode(node: PlannedNode): number {
    this._nodes.push(node);
    this._nodes.sort((a, b) => a.time - b.time);
    return this._nodes.indexOf(node);
  }

  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.splice(idx, 1);
  }

  // 直近ノード(達成済み)を1件消費する。plan-guide.ts の達成判定からのみ呼ぶ。
  consumeFirstNode(): void {
    this._nodes.shift();
  }

  clear(): void {
    if (this._nodes.length === 0) return;
    this._nodes = [];
  }

  // ノードを新しい実行時刻・実行後状態へ移す(リタイム)。時刻順に再ソートし、移動後の
  // ノードより下流を破棄する。戻り値は再ソート後の index。
  retimeNode(idx: number, time: number, postState: OrbitState): number {
    const node = this._nodes[idx];
    if (!node) return idx;
    node.time = time;
    node.postState = postState;
    this._nodes.sort((a, b) => a.time - b.time);
    const newIdx = this._nodes.indexOf(node);
    this._nodes.length = newIdx + 1; // 下流ノードを破棄(千切れさせない = 削除)
    return newIdx;
  }

  // 選択中ノードの実行後速度へワールド Δv を加える(pro/nrm/rad → world の変換は editor)。
  // 上流編集なので下流ノードを破棄する。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node || (dvWorld.x === 0 && dvWorld.y === 0 && dvWorld.z === 0)) return;
    node.postState = orbitState(node.postState.r, add(node.postState.v, dvWorld));
    if (idx < this._nodes.length - 1) this._nodes.length = idx + 1;
  }
}
