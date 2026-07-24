// 軌道計画(ノード列)とその起点アンカー、数値予測キャッシュ。マップモードの有無に
// 関わらず存在するデータで、PlanSystem が所有し、実施(plan-guide.ts)へは Game 経由で
// 注入する。ノードの追加・削除・並べ替え・編集は必ずこのクラスのメソッド経由で行う。
//
// データモデル(Step2):
//  - plannedPlayerStart: 予定 player の起点(frozen アンカー)。計画が空の間だけ
//    trackAnchor() で自機の現在状態へ追従し、最初のノードを置いた瞬間に凍結される
//    (以降は手動クリアで空へ戻すまで動かない)。予測はこのアンカー + 凍結ノードだけの
//    純関数で、player.live には依存しない。
//  - nodes: 各曲がり角の {time, 実行後 postState(r,v とも凍結)}。相対 Δv は持たない。
//  - trajSamples: 予測の隣接キャッシュ(正データではない導出値)。計算は predict-system
//    が持ち、maybeRefresh に compute を注入で受け取って貯めるだけ。
//
// 上流ノードを編集すると下流ノードの凍結状態は無効になるため、編集メソッドは編集ノード
// より後(時刻が後)のノードを破棄する(千切れさせない = 削除。再スナップはしない)。
import { orbitState, OrbitState } from '../../physics/orbital';
import { PlannedNode, TrajectorySample, sampleAt } from '../../physics/predict';
import { Vec3, add, clone, v3 } from '../../physics/vec3';
import * as C from '../const';

export interface PlanAnchor {
  time: number;
  state: OrbitState;
}

export class Plan {
  private _nodes: PlannedNode[] = [];
  private _anchor: PlanAnchor = { time: 0, state: orbitState(v3(), v3()) };
  private _trajSamples: TrajectorySample[] = [];
  private dirty = true;
  private lastRefreshMs = -Infinity;

  get nodes(): readonly PlannedNode[] {
    return this._nodes;
  }

  // 予定 player の起点(frozen アンカー)。predict はこれと nodes だけの純関数。
  get anchor(): PlanAnchor {
    return this._anchor;
  }

  // 最後に計算した予測サンプル列。配列そのものは maybeRefresh() のたびに新しい参照へ
  // 差し替わるので、消費側は参照の変化を「予測が更新された」の検出に使ってよい。
  get trajSamples(): readonly TrajectorySample[] {
    return this._trajSamples;
  }

  firstNode(): PlannedNode | undefined {
    return this._nodes[0];
  }

  // 予測に使う期間ポリシー自体が切り替わった(例: 表示期間・太陽回転系の変更)等、
  // ノード自体は変わっていなくても再計算が必要な場合に呼ぶ。
  markDirty(): void {
    this.dirty = true;
  }

  sampleAt(t: number): TrajectorySample | null {
    return sampleAt(this._trajSamples, t);
  }

  // 計画が空の間だけ、予定 player の起点を現在の自機状態へ追従させる(editor が設計時に
  // player.live を読む唯一の経路)。最初のノードを置いてアンカーが凍結されたら no-op に
  // なり、以降 predict は player.live 非依存になる。clear() で空へ戻すと追従を再開する。
  trackAnchor(time: number, state: OrbitState): void {
    if (this._nodes.length > 0) return;
    this._anchor = { time, state: orbitState(clone(state.r), clone(state.v)) };
    // アンカーが動いたら次の refresh で予測を引き直す(空プランナーの表示を現在位置へ)。
    this.dirty = true;
  }

  addNode(node: PlannedNode): number {
    this._nodes.push(node);
    this._nodes.sort((a, b) => a.time - b.time);
    this.dirty = true;
    return this._nodes.indexOf(node);
  }

  removeNode(idx: number): void {
    if (!this._nodes[idx]) return;
    this._nodes.splice(idx, 1);
    this.dirty = true;
  }

  // 直近ノード(達成済み)を1件消費する。plan-guide.ts の達成判定からのみ呼ぶ。
  consumeFirstNode(): void {
    this._nodes.shift();
    this.dirty = true;
  }

  clear(): void {
    if (this._nodes.length === 0) return;
    this._nodes = [];
    this.dirty = true;
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
    this.dirty = true;
    return newIdx;
  }

  // 選択中ノードの実行後速度へワールド Δv を加える(pro/nrm/rad → world の変換は editor)。
  // 上流編集なので下流ノードを破棄する。
  applyNodeDv(idx: number, dvWorld: Vec3): void {
    const node = this._nodes[idx];
    if (!node || (dvWorld.x === 0 && dvWorld.y === 0 && dvWorld.z === 0)) return;
    node.postState = orbitState(node.postState.r, add(node.postState.v, dvWorld));
    if (idx < this._nodes.length - 1) this._nodes.length = idx + 1;
    this.dirty = true;
  }

  // 予測キャッシュを最新化する。実際の予測計算は呼び出し側が compute で注入する
  // — Plan は「自分の持つキャッシュが古いか(スロットル)」と「結果の保管」だけを担う。
  // dirty なら ~5Hz、そうでなければ2秒ごとに再計算する。消費者はマップ表示のみ
  // (噴射ガイドは Step2 で postState 直読みに移行し、予測を消費しなくなった)。
  maybeRefresh(compute: () => TrajectorySample[]): void {
    const elapsed = performance.now() - this.lastRefreshMs;
    const threshold = this.dirty ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
    if (elapsed < threshold) return;
    this._trajSamples = compute();
    this.dirty = false;
    this.lastRefreshMs = performance.now();
  }
}
