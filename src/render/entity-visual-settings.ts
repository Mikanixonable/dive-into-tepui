// 個体ごとの毎フレーム同期処理が参照する描画設定インターフェース。品質設定のうち、メッシュと付随表示を
// displayTime の状態へ合わせるときに効く項目だけを持つ。
import type { ThrustPlumeMode } from './dynamic/player/thrust-effects';

export interface EntityVisualSettings {
  readonly proteinVibration: boolean;
  // 主推進プルームの描き方。
  readonly thrustPlume: ThrustPlumeMode;
}
