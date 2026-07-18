// マニューバ計画(ノード列)と予測軌道キャッシュ。マップモードでなくても生きている
// (確定済みノードの噴射ガイドは戦闘ビューで表示される)。
// game.ts を import しない — 依存は PlannerCtx 引数経由のみ。
import { Elements, elementsFromState } from '../physics/orbital';
import { sunAzimuth } from '../physics/ephemeris';
import { PlannedNode, PredictOpts, TrajectorySample, predictTrajectory } from '../physics/predict';
import { Vec3 } from '../physics/vec3';
import * as C from './const';

// refresh() / predictDurationSec() が必要とする、Game 側の現在状態のスナップショット。
export interface PlannerCtx {
  simTime: number;
  playerR: Vec3; // player.state.r
  playerV: Vec3; // player.state.v
  sunPhase0: number;
  moonPhase0: number;
  mapMode: boolean;
  mapFrameRotating: boolean;
}

export class MapPlanner {
  // 複数ノード・時間ベースの軌道計画(絶対 simTime を持つノードの列。時刻順)。
  // 各ノードの Δv はノード実行時点の(その時点までの計画を反映した)速度を基準に
  // プログレード/ノーマル/ラジアルアウト成分で保持する — ワープで時間が進んでも
  // ノード自体の実行時刻は絶対時刻なのでドリフトしない。
  planNodes: PlannedNode[] = [];
  selectedNodeIdx: number | null = null;
  // 数値予測(predict.ts)の結果キャッシュ。マップモードのポリライン描画・
  // クリックピッキング・戦闘ビューの噴射ガイドの双方で共有する。
  trajSamples: TrajectorySample[] = [];
  trajDirty = true; // ノード変更等で再計算が必要
  trajGeomDirty = true; // trajLine のジオメトリ再構築が必要(refreshTrajectory 後に立てる)
  trajLastRefreshMs = -Infinity; // performance.now() 基準
  // マップモードの「太陽回転系」表示で、予測サンプルを t_now 時点の太陽方位へ
  // 揃えるための回転角。再計算(refreshTrajectory)のたびに固定し、次の
  // 再計算まではクリック判定・描画とも同じ値を使う(表示と判定の整合を取るため)。
  trajYawRef = 0;
  predictDurationKey: 'orbit' | 'day' | 'week' | 'month' = 'day';

  // 選んだ期間、戦闘ビューでは直近の未達成ノードをちょうど含む程度の短い期間だけ
  // 計算する(28日ぶんを毎回計算するのは無駄なコストになるため)。
  predictDurationSec(ctx: PlannerCtx): number {
    if (this.predictDurationKey === 'orbit') {
      const el: Elements | null = elementsFromState(ctx.playerR, ctx.playerV);
      if (el && isFinite(el.period) && el.period > 0) return el.period;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.predictDurationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.predictDurationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  refresh(ctx: PlannerCtx): void {
    let duration: number;
    if (ctx.mapMode) {
      duration = this.predictDurationSec(ctx);
    } else {
      const first = this.planNodes[0];
      duration = first ? Math.max(60, first.time - ctx.simTime + 120) : 0;
    }
    if (duration <= 0) {
      this.trajSamples = [];
    } else {
      const opts: PredictOpts = {
        sunPhase0: ctx.sunPhase0,
        moonPhase0: ctx.moonPhase0,
        maxSamples: C.PREDICT_MAX_SAMPLES,
      };
      this.trajSamples = predictTrajectory(
        { r: ctx.playerR, v: ctx.playerV },
        ctx.simTime,
        duration,
        this.planNodes,
        opts,
      );
    }
    this.trajYawRef = ctx.mapFrameRotating ? sunAzimuth(ctx.simTime, ctx.sunPhase0) : 0;
    this.trajDirty = false;
    this.trajGeomDirty = true;
    this.trajLastRefreshMs = performance.now();
  }

  // dirty フラグが立っていれば ~5Hz、そうでなければ2秒ごとに予測を再計算する。
  // マップモードでもなくノードもなければ(表示・ガイドとも不要なので)何もしない。
  maybeRefresh(ctx: PlannerCtx): void {
    const needed = ctx.mapMode || this.planNodes.length > 0;
    if (!needed) {
      if (this.trajSamples.length > 0) this.trajSamples = [];
      return;
    }
    const elapsed = performance.now() - this.trajLastRefreshMs;
    const threshold = this.trajDirty ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
    if (elapsed >= threshold) this.refresh(ctx);
  }
}
