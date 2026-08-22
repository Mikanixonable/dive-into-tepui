import { Game } from './game/game';
import type { Input } from './game/input/input';
import { KEY_MAPPING as K } from './game/input/key-mapping';
import { Hud } from './game/hud/hud';
import { PauseMenu } from './game/hud/pause-menu';
import { SaveBrowser } from './game/hud/save-browser';
import { SnapshotService } from './game/save/snapshot-service';

// F5(クリップ)/F9(一覧開閉)の入力を担う。一覧表示中の Esc は OverlayManager の登録経由で
// 閉じるので、ここでは扱わない。main.ts が rAF ループから Game.update の後に呼ぶ —
// その回で Game 側が消費しなかった入力エッジだけが残っている。
export class SnapshotControls {
  constructor(
    private readonly hud: Hud,
    private readonly pauseMenu: PauseMenu,
    private readonly browser: SaveBrowser,
    private readonly service: SnapshotService,
  ) {}

  handleInput(input: Input, game: Game): void {
    if (input.takeKey(K.clipSnapshot)) this.captureManual(game);

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

  // 現在の瞬間を名前付きスナップショットとして残す。[F5] と ESC メニューの「セーブ」
  // ボタンの共通処理。game が無ければ何もしない。
  captureManual(game: Game | null): void {
    if (game === null) return;
    // 決着後の phase(won/lost/timeup)は復元する経路を持たない — 復元は phase を
    // そのまま代入するだけで結果画面を出し直さないので、ロードすると結果画面の無いまま
    // 決着済みのステージが続くことになる。
    if (!game.activeStage.isPlaying) {
      this.hud.hint('決着後はスナップショットを残せません');
      return;
    }
    const snap = this.service.capture(game, 'manual', null, true);
    this.hud.hint(snap ? `クリップしました: ${snap.name}` : 'クリップに失敗しました');
  }
}
