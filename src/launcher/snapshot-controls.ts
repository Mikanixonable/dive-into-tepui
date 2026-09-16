import { KEY_MAPPING as K } from '../input/key-mapping';
import type { Notifier } from '../hud/notifier';
import { PauseMenu } from '../hud/windows/pause-menu';
import { SaveBrowser } from './save-browser/save-browser';
import { SnapshotService, type SnapshotCaptureSource } from './save/snapshot-service';

// F5(クリップ)/F9(一覧開閉)のcommandを担う。Game.update のあとにrouterから呼ぶ。
export class SnapshotControls {
  constructor(
    private readonly notifier: Notifier,
    private readonly pauseMenu: PauseMenu,
    private readonly browser: SaveBrowser,
    private readonly service: SnapshotService,
  ) {}

  handleCommand(commandId: string, source: SnapshotCaptureSource): void {
    if (commandId === K.clipSnapshot.code) this.captureManual(source);

    if (commandId === K.openSnapshots.code) {
      if (this.browser.visible) {
        this.browser.close();
      } else {
        // ポーズは入れ子にならない真偽値なので、同じ帯のシステム窓を重ねない。
        this.pauseMenu.toggle(false);
        this.browser.open();
      }
    }
  }

  // 現在の瞬間を名前付きスナップショットとして残す。[F5] と ESC メニューの「セーブ」
  // ボタンの共通処理。保存sourceが無ければ何もしない。
  captureManual(source: SnapshotCaptureSource | null): void {
    if (source === null) return;
    // 決着後の phase(won/lost/timeup)は復元する経路を持たない — 復元は phase を
    // そのまま代入するだけで結果画面を出し直さないので、ロードすると結果画面の無いまま
    // 決着済みのステージが続くことになる。
    if (!source.isPlaying) {
      this.notifier.hint('決着後はスナップショットを残せません');
      return;
    }
    const snap = this.service.capture(source.runSummary(), source.serialize(), 'manual', null, true);
    this.notifier.hint(snap ? `クリップしました: ${snap.name}` : 'クリップに失敗しました');
  }
}
