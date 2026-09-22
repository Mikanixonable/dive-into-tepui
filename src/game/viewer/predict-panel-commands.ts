// 予測パネルの選択へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { FrameRotationSource } from '../../physics/frame';
import type { CommandQueue } from '../command-queue';
import type {
  DisplayDurationKey, DisplayPastDurationKey, PredictPanelSelection, TickLabelMode,
} from './predict-panel-selection';

// 予測パネルの選択を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface PredictPanelCommands {
  // 未来側の表示期間を key へ切り替える。
  selectDuration(key: Exclude<DisplayDurationKey, 'custom'>): void;
  // 未来側の任意期間を sec にして選ぶ。
  selectCustomDuration(sec: number): void;
  // 過去側の表示期間を key へ切り替える。
  selectPastDuration(key: Exclude<DisplayPastDurationKey, 'custom'>): void;
  // 過去側の任意期間を sec にして選ぶ。
  selectCustomPastDuration(sec: number): void;
  // スクラブ位置を表示期間に対する比率 t へ移す。
  setSliderT(t: number): void;
  // 表示期間 durationSec の先頭から sec の位置へ移す。
  jumpToTime(sec: number, durationSec: number): void;
  // 時刻ラベルの表記を mode へ切り替える。
  setTickLabelMode(mode: TickLabelMode): void;
  // 軌道要素マーカーへ通過時刻を併記するかを切り替える。
  setShowElementTimes(show: boolean): void;
  // スライダーの目盛りを表示するかを切り替える。
  setShowTicks(show: boolean): void;
  // 描画座標系の中心を id へ差し替える。
  setFrameCenter(id: string): void;
  // 描画座標系の回転を rotatingWith へ差し替える。
  setFrameRotation(rotatingWith: FrameRotationSource | null): void;
  // カメラの基準へ描画基準を追随させるかを切り替える。
  setFollowCamera(on: boolean): void;
  // カメラの基準が id へ移ったことを伝える。
  followCameraFocus(id: string | undefined): void;
  // 描画座標系の回転を外す。
  dropRotation(): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function predictPanelCommands(
  queue: CommandQueue, selection: PredictPanelSelection,
): PredictPanelCommands {
  return {
    selectDuration: (key) => queue.submit(() => selection.selectDuration(key)),
    selectCustomDuration: (sec) => queue.submit(() => selection.selectCustomDuration(sec)),
    selectPastDuration: (key) => queue.submit(() => selection.selectPastDuration(key)),
    selectCustomPastDuration: (sec) => queue.submit(() => selection.selectCustomPastDuration(sec)),
    setSliderT: (t) => queue.submit(() => selection.setSliderT(t)),
    jumpToTime: (sec, durationSec) => queue.submit(() => selection.jumpToTime(sec, durationSec)),
    setTickLabelMode: (mode) => queue.submit(() => selection.setTickLabelMode(mode)),
    setShowElementTimes: (show) => queue.submit(() => selection.setShowElementTimes(show)),
    setShowTicks: (show) => queue.submit(() => selection.setShowTicks(show)),
    setFrameCenter: (id) => queue.submit(() => selection.setFrameCenter(id)),
    setFrameRotation: (rotatingWith) => queue.submit(() => selection.setFrameRotation(rotatingWith)),
    setFollowCamera: (on) => queue.submit(() => selection.setFollowCamera(on)),
    followCameraFocus: (id) => queue.submit(() => selection.followCameraFocus(id)),
    dropRotation: () => queue.submit(() => selection.dropRotation()),
  };
}
