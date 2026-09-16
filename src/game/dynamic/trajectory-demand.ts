// 表示の導出が1フレームぶんの入力として進行へ渡す、軌跡をどこまで計算してほしいかの表明。
// 予測を伸ばす長さ・履歴を残す長さ・伸ばす計画の弧を1つにまとめる。
import type { PredictedArc } from './predicted-arc';

export interface TrajectoryDemand {
  // 予測を simTime から先へ伸ばす長さ [s]。
  readonly horizon: number;
  // 実軌跡を simTime から過去へ残す長さ [s]。0 以上の有限値。
  readonly historyDuration: number;
  // 時刻順に並べた、伸ばす計画の弧。
  readonly planArcs: readonly PredictedArc[];
}
