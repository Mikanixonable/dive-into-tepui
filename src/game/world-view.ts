// ビュー(戦闘/マップ)固有の処理の口。フレーム処理は Game が update/sync の固定位置で
// 現在のビューの実装だけを呼び、遷移フックは ViewManager が setView() の中で呼ぶ。
// 両ビュー共通のフレーム処理は Game が地の文で持つ。
import type { DisplayWindow } from './display-window-manager';

export interface WorldViewFrame {
  // このビューへ遷移できるか。
  canEnter(): boolean;
  // このビューへ入るときの支度。実遷移時のみで、構築時の初期ビューでは呼ばれない。
  onEnter(): void;
  // このビューから出るときの後始末。実遷移時のみ。
  onLeave(): void;
  // ポーズ・入力ゲートの判定後に呼ばれる。ポインタ入力の配分。
  handlePointer(simTime: number): void;
  // update フェーズ: カメラ更新の後。選択候補と可視性ポリシーの確定。
  update(displayWindow: DisplayWindow): void;
  // sync フェーズ前半: 天体ラベル。マーカー同期が近接判定に読むため、その前に呼ばれる。
  syncLabels(): void;
  // sync フェーズ後半: ビュー専用の常設パネル・表示物。軌道線の同期より後に呼ばれる。
  syncPanels(displayWindow: DisplayWindow): void;
}
