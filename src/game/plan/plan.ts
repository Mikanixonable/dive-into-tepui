// 軌道計画(ノード列)とその数値予測キャッシュ。マップモードの有無に関わらず存在する
// データで、MapModeSystem が所有し、実施(plan-guide.ts)へは Game 経由で注入する。
// ノードの追加・削除・並べ替えは必ずこのクラスのメソッド経由で行う — 呼び出し側が
// nodes 配列を直接 splice すると「同じ削除ロジックの重複」を招く。
import { PlannedNode, PredictOpts, TrajectorySample, predictTrajectory, sampleAt } from '../../physics/predict';
import { len } from '../../physics/vec3';
import * as C from '../const';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';

export class Plan {
  private _nodes: PlannedNode[] = [];
  private _trajSamples: TrajectorySample[] = [];
  private dirty = true;
  private lastRefreshMs = -Infinity;

  get nodes(): readonly PlannedNode[] {
    return this._nodes;
  }

  // predictTrajectory() が最後に計算した予測サンプル列。配列そのものは refresh() の
  // たびに新しい参照へ差し替わるので、消費側は参照の変化を「予測が更新された」の
  // 検出に使ってよい。
  get trajSamples(): readonly TrajectorySample[] {
    return this._trajSamples;
  }

  firstNode(): PlannedNode | undefined {
    return this._nodes[0];
  }

  // 予測に使う期間ポリシー自体が切り替わった(例: マップモードの開閉)等、ノード自体は
  // 変わっていなくても再計算が必要な場合に呼ぶ。
  markDirty(): void {
    this.dirty = true;
  }

  sampleAt(t: number): TrajectorySample | null {
    return sampleAt(this._trajSamples, t);
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

  // ノードを新しい実行時刻へ移動し、時刻順を保つよう再ソートする。戻り値は再ソート後の index。
  setNodeTime(idx: number, time: number): number {
    const node = this._nodes[idx];
    if (!node || node.time === time) return idx;
    node.time = time;
    this._nodes.sort((a, b) => a.time - b.time);
    this.dirty = true;
    return this._nodes.indexOf(node);
  }

  adjustNodeDv(idx: number, dx: number, dy: number, dz: number): void {
    const node = this._nodes[idx];
    if (!node || (dx === 0 && dy === 0 && dz === 0)) return;
    node.dv = { x: node.dv.x + dx, y: node.dv.y + dy, z: node.dv.z + dz };
    this.dirty = true;
  }

  // Δv がほぼゼロのまま放置されたノードを破棄する([M] でマップを閉じる際の後始末)。
  pruneNearZeroDv(minDv: number): void {
    const filtered = this._nodes.filter((n) => len(n.dv) >= minDv);
    if (filtered.length !== this._nodes.length) {
      this._nodes = filtered;
      this.dirty = true;
    }
  }

  // dirty なら ~5Hz、そうでなければ2秒ごとに予測を再計算する(スロットリング)。
  // duration は呼び出し側が決める — マップモードの表示用と噴射ガイド用とで
  // 必要な予測範囲が異なるため。
  maybeRefresh(player: Player, ephemeris: EphemerisSystem, simTime: number, duration: number): void {
    const elapsed = performance.now() - this.lastRefreshMs;
    const threshold = this.dirty ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
    if (elapsed < threshold) return;
    this.refresh(player, ephemeris, simTime, duration);
  }

  private refresh(player: Player, ephemeris: EphemerisSystem, simTime: number, duration: number): void {
    if (duration <= 0) {
      this._trajSamples = [];
    } else {
      const opts: PredictOpts = {
        sunPhase0: ephemeris.sunPhase0,
        moonPhase0: ephemeris.moonPhase0,
        maxSamples: C.PREDICT_MAX_SAMPLES,
      };
      this._trajSamples = predictTrajectory(
        { r: player.state.r, v: player.state.v },
        simTime,
        duration,
        this._nodes,
        opts,
      );
    }
    this.dirty = false;
    this.lastRefreshMs = performance.now();
  }
}
