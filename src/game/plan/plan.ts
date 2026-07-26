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
import { orbitState, OrbitState } from '../../physics/orbital';
import { Vec3, add, v3 } from '../../physics/vec3';

export class Plan {
  private _nodes: OrbitState[] = [];
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
    this._nodes.push(postState);
    this._nodes.sort((a, b) => a.t - b.t);
    return this._nodes.indexOf(postState);
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

  // ノードを新しい実行後状態(時刻込み)へ移す(リタイム)。時刻順に再ソートし、移動後の
  // ノードより下流を破棄する。戻り値は再ソート後の index。
  retimeNode(idx: number, postState: OrbitState): number {
    if (!this._nodes[idx]) return idx;
    this._nodes[idx] = postState;
    this._nodes.sort((a, b) => a.t - b.t);
    const newIdx = this._nodes.indexOf(postState);
    this._nodes.length = newIdx + 1; // 下流ノードを破棄(千切れさせない = 削除)
    return newIdx;
  }

  // 選択中ノードの実行後速度へワールド Δv を加える(pro/nrm/rad → world の変換は editor)。
  // 上流編集なので下流ノードを破棄する。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node || (dvWorld.x === 0 && dvWorld.y === 0 && dvWorld.z === 0)) return;
    this._nodes[idx] = orbitState(node.t, node.r, add(node.v, dvWorld));
    if (idx < this._nodes.length - 1) this._nodes.length = idx + 1;
  }
}
