import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { PauseMenu } from '../hud/windows/pause-menu';
import type { Hud } from './hud/hud';
import type { SimSpeedManager } from './dynamic/sim-speed-manager';
import type { ViewManager } from './view/view-manager';

// 生入力を確定し、ゲーム画面内の入力先へ優先順位どおりに配る。
export class InputCoordinator {
  constructor(
    private readonly input: Input,
    private readonly hud: Hud,
    private readonly pauseMenu: PauseMenu,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly viewManager: ViewManager,
  ) {}

  // dtRaw をゲーム内の上限へ収め、次のシミュレーション・表示更新へ返す。
  update(dtRaw: number, simTime: number): number {
    this.input.update();
    const dt = Math.min(dtRaw, 0.1);

    // ポーズ中も Esc・ヘルプなどは効かせるので、入力配分はポーズ判定より前に置く。
    // ESC: 開いているオーバーレイがあれば最前面を閉じ、何も無ければ一時停止メニューを開く。
    if (this.input.takeKey(K.pauseMenu)) {
      if (!this.hud.overlayManager.closeTopmostOnEscape()) this.pauseMenu.toggle(true);
    }
    // オーバーレイの項目ショートカット([F]等)も同じ優先度で最前面へ配送する。
    this.input.takeKeys((code) => this.hud.overlayManager.dispatchShortcut(code));
    // 上から下へ優先順位順に呼ぶ。
    this.hud.handleInput(this.input);
    // ヘルプや設定など、背景入力をゲートするモーダルが開いた後は、同じフレームの
    // ワープ/ビュー切り替え/計画編集へキーを漏らさない。
    if (this.hud.overlayManager.isInputGated()) return dt;
    this.simSpeedManager.handleInput(this.input);
    this.viewManager.handleInput(this.input);
    // ビュー固有のキー(戦闘=計画破棄/自動ワープ、マップ=Δv 編集)は現在のビューが持つ。
    this.viewManager.activeView.handleInput(this.input, dt, simTime);
    return dt;
  }
}
