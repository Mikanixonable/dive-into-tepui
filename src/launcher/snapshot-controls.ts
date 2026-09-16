import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { Notifier } from '../hud/notifier';
import { PauseMenu } from '../hud/windows/pause-menu';
import { SaveBrowser } from './save-browser/save-browser';
import { SnapshotService, type SnapshotCaptureSource } from './save/snapshot-service';

// F5(手動セーブ)/F9(一覧開閉)の入力を担う。handleInput は Game.update のあとに呼ぶ —
// その回で Game が消費しなかった入力エッジだけを見る。
export class SnapshotControls {
  constructor(
    private readonly notifier: Notifier,
    private readonly pauseMenu: PauseMenu,
    private readonly browser: SaveBrowser,
    private readonly service: SnapshotService,
  ) {}

  handleInput(input: Input, source: SnapshotCaptureSource): void {
    if (input.takeKey(K.clipSnapshot)) this.saveManually(source);

    if (input.takeKey(K.openSnapshots)) {
      if (this.browser.visible) {
        this.browser.close();
      } else {
        // ポーズは入れ子にならない真偽値なので、同じ帯のシステム窓を重ねない。
        this.pauseMenu.toggle(false);
        this.browser.open();
      }
    }
  }

  // 現在の瞬間を無名の手動セーブとして残す。source が無ければ何もしない。
  saveManually(source: SnapshotCaptureSource | null): void {
    if (source === null) return;
    // 決着後の phase(won/lost/timeup)は復元する経路を持たない — 復元は phase を
    // そのまま代入するだけで結果画面を出し直さないので、ロードすると結果画面の無いまま
    // 決着済みのステージが続くことになる。
    if (!source.isPlaying) {
      this.notifier.hint('決着後はセーブできません');
      return;
    }
    const snap = this.service.addManualSave(source.runSummary(), source.serialize(), null);
    this.notifier.hint(snap ? `セーブしました: ${snap.name}` : 'セーブに失敗しました');
  }
}
