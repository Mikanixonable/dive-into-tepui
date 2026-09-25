import { KEY_MAPPING as K } from '../input/key-mapping';
import type { Notifier } from '../hud/notifier';
import type { PauseMenu } from '../hud/windows/pause-menu';
import type { SaveBrowser } from './save-browser/save-browser';
import type { SnapshotService, SnapshotSource } from './save/snapshot-service';

// F5(手動セーブ)/F9(一覧開閉)の単発入力を担う。router へはランの入力の解釈のあとに足す —
// その回でランが消費しなかった入力エッジだけを見る。
export class SnapshotControls {
  public constructor(
    private readonly notifier: Notifier,
    private readonly pauseMenu: PauseMenu,
    private readonly browser: SaveBrowser,
    private readonly service: SnapshotService,
  ) {}

  // router から手動セーブのキーと一覧の開閉キーを受け取る。source は記録を残すときに読む今の周回。
  public handleCommand(commandId: string, source: SnapshotSource): void {
    if (commandId === K.manualSave.code) this.saveManually(source);

    if (commandId === K.openSaveBrowser.code) {
      if (this.browser.visible) {
        this.browser.close();
      } else {
        // 一覧と ESC メニューは同じシステム窓の帯にいるので、開くときもう片方は閉じる。
        this.pauseMenu.toggle(false);
        this.browser.open();
      }
    }
  }

  // 現在の瞬間を無名の手動セーブとして残す。source が無ければ何もしない。
  public saveManually(source: SnapshotSource | null): void {
    if (source === null) return;
    // 決着後の状態を残すと、結果画面へ辿り着けない記録になる(SAVE.md「記録」)。
    if (!source.isPlaying) {
      this.notifier.hint('決着後はセーブできません', undefined, 'warn');
      return;
    }
    const snap = this.service.addManualSave(source.runSummary(), source.serialize(), null);
    this.notifier.hint(
      snap ? `セーブしました: ${snap.name}` : 'セーブに失敗しました',
      undefined,
      snap ? 'info' : 'warn',
    );
  }
}
