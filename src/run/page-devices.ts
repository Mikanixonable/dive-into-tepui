// ページの寿命の装置の束。どのランにも同じものが渡る。
import type { GameScene } from '../render/scene';
import type { Hud } from '../game/hud/hud';
import type { MarkerDevice } from '../marker/marker-device';
import type { AudioEngine } from '../audio/audio-engine';
import type { PauseMenu } from '../hud/windows/pause-menu';
import type { DebugInfoWindow } from '../game/hud/windows/debug-info-window';

export interface PageDevices {
  readonly scene: GameScene;
  readonly hud: Hud;
  // 画面へ重ねるマーカーの装置。
  readonly markers: MarkerDevice;
  readonly audioEngine: AudioEngine;
  readonly pauseMenu: PauseMenu;
  // フレームの所要時間と計測値を集めて見せる窓。
  readonly debugInfo: DebugInfoWindow;
  // 組み立て中のランが自分を置く、ランが無いフレームで前倒し駆動する口。
  // 起動の完了・失敗のどちらでも null へ戻す。
  loadingJobs: { drivePendingJobs(timeBudgetMs: number): void } | null;
}
