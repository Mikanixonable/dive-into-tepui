// 跳ぶカメラの切り替えを、描画フレームどうしの比較で見つけ、描画パイプラインへ渡す変化量にする。
import type { ViewMode } from '../view/view-mode';

// 履歴を捨てるか比べるための、描画フレームのカメラ状態。
export interface CameraCutKey {
  readonly view: ViewMode;
  readonly gunsight: boolean;
  readonly focusTargetId: string | undefined;
}

// 前回の描画フレームから跳ぶ切り替えがあれば、履歴を捨てる変化量を返す。
export function cameraCutChangeOf(previous: CameraCutKey | null, current: CameraCutKey): number {
  if (previous === null) return 0;
  return previous.view === current.view
    && previous.gunsight === current.gunsight
    && previous.focusTargetId === current.focusTargetId
    ? 0
    : Number.POSITIVE_INFINITY;
}
