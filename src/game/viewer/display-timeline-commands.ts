// タイムラインパネルの選択へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { FrameRotationSource } from '../../physics/frame';
import type { CommandQueue } from '../command-queue';
import type {
  DisplayDurationKey, DisplayTimelineSelection, TickLabelMode,
} from './display-timeline-selection';

// タイムラインパネルの選択を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface DisplayTimelineCommands {
  // 表示期間を key へ切り替える。
  selectDuration(key: Exclude<DisplayDurationKey, 'custom'>): void;
  // 任意の表示期間を sec にして選ぶ。
  selectCustomDuration(sec: number): void;
  // スクラブ位置を時間軸全域に対する位置 t(0.5 が現在)へ移す。
  setSliderT(t: number): void;
  // 現在からの相対時刻 sec(負なら過去側)へスクラブ位置を移す。
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
  followCameraFocus(id: string | null): void;
  // カメラの回転追従が rotatingWith へ変わったことを伝える。
  followCameraRotation(rotatingWith: FrameRotationSource | null): void;
  // 描画座標系の回転を外す。
  dropRotation(): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function displayTimelineCommands(
  queue: CommandQueue, selection: DisplayTimelineSelection,
): DisplayTimelineCommands {
  return {
    selectDuration: (key) => queue.submit(() => selection.selectDuration(key)),
    selectCustomDuration: (sec) => queue.submit(() => selection.selectCustomDuration(sec)),
    setSliderT: (t) => queue.submit(() => selection.setSliderT(t)),
    jumpToTime: (sec, durationSec) => queue.submit(() => selection.jumpToTime(sec, durationSec)),
    setTickLabelMode: (mode) => queue.submit(() => selection.setTickLabelMode(mode)),
    setShowElementTimes: (show) => queue.submit(() => selection.setShowElementTimes(show)),
    setShowTicks: (show) => queue.submit(() => selection.setShowTicks(show)),
    setFrameCenter: (id) => queue.submit(() => selection.setFrameCenter(id)),
    setFrameRotation: (rotatingWith) => queue.submit(() => selection.setFrameRotation(rotatingWith)),
    setFollowCamera: (on) => queue.submit(() => selection.setFollowCamera(on)),
    followCameraFocus: (id) => queue.submit(() => selection.followCameraFocus(id)),
    followCameraRotation: (rotatingWith) => queue.submit(() => selection.followCameraRotation(rotatingWith)),
    dropRotation: () => queue.submit(() => selection.dropRotation()),
  };
}
