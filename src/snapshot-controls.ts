import { Game } from './game/game';
import type { Input } from './game/input/input';
import { KEY_MAPPING as K } from './game/input/key-mapping';
import { Hud } from './game/hud/hud';
import { SettingsPanel } from './game/hud/settings-panel';
import { SaveBrowser } from './game/hud/save-browser';
import { SnapshotService } from './game/save/snapshot-service';

// F5(クリップ)/F9(一覧開閉)/一覧表示中のEscの入力を担う。main.ts が rAF ループから
// Game.update の後に呼ぶ — その回で Game 側が消費しなかった入力エッジだけが残っている。
export class SnapshotControls {
  constructor(
    private readonly hud: Hud,
    private readonly settingsPanel: SettingsPanel,
    private readonly browser: SaveBrowser,
    private readonly service: SnapshotService,
  ) {}

  handleInput(input: Input, game: Game): void {
    // スナップショット一覧を開いている間は、その閉じるキーとして [Esc] を先に取る
    // (設定メニューが上に重なるのを防ぐ)。
    if (this.browser.visible && input.takeKey(K.pauseMenu)) {
      this.browser.close();
      return;
    }

    if (input.takeKey(K.clipSnapshot)) {
      // 決着後の phase(won/lost/timeup)は復元する経路を持たない — 復元は phase を
      // そのまま代入するだけで結果画面を出し直さないので、ロードすると結果画面の無いまま
      // 決着済みのステージが続くことになる。
      if (!game.activeStage.isPlaying) {
        this.hud.hint('決着後はスナップショットを残せません');
      } else {
        const snap = this.service.capture(game, 'manual', null, true);
        this.hud.hint(snap ? `クリップしました: ${snap.name}` : 'クリップに失敗しました');
      }
    }

    if (input.takeKey(K.openSnapshots)) {
      if (this.browser.visible) {
        this.browser.close();
      } else {
        // ポーズは入れ子にならない真偽値なので、同じ帯のシステム窓を重ねない。
        this.settingsPanel.toggle(false);
        this.browser.open();
      }
    }
  }
}
