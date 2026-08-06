// 一時停止 / 設定パネル(BGM トグル・タイトルへ戻る・閉じる)とギアボタン。
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import * as C from '../const';
import { syncHudModalState } from './dom';

export class SettingsPanel {
  private readonly panel: HTMLElement;


  onSettingsOpenChange: ((open: boolean) => void) | null = null;
  onQuitToTitle: (() => void) | null = null;
  onBgmVolumeChange: ((vol: number) => void) | null = null;

  // ⚙ ボタンとパネル DOM を組み立て、開閉・BGM トグル・タイトルへ戻るのイベントを配線する。
  constructor(root: HTMLElement) {

    // パネル本体
    this.panel = document.createElement('div');
    this.panel.id = 'hud-settings';
    this.panel.className = 'panel';
    this.panel.innerHTML = `
      <h3>一時停止 / 設定</h3>
      <div class="srow"><span class="k">BGM Vol</span><input type="range" data-id="bgmslider" min="0" max="1" step="0.05" value="1" style="flex:1; margin-left: 10px; cursor: pointer; accent-color: ${C.COLOR_ACCENT};"></div>
      <div class="squit" data-id="settingsquit">ゲームを中断してタイトル画面に戻る</div>
      <div class="sclose" data-id="settingsclose">[閉じる]</div>`;
    root.appendChild(this.panel);

    // BGM スライダー
    const bgmSlider = this.panel.querySelector<HTMLInputElement>('[data-id="bgmslider"]')!;
    bgmSlider.addEventListener('input', () => {
      const vol = parseFloat(bgmSlider.value);
      this.onBgmVolumeChange?.(vol);
    });
    // タイトルへ戻る
    this.panel.querySelector<HTMLElement>('[data-id="settingsquit"]')!.addEventListener('click', () => {
      this.onQuitToTitle?.();
    });
    // 閉じる
    this.panel.querySelector<HTMLElement>('[data-id="settingsclose"]')!.addEventListener('click', () =>
      this.toggle(false),
    );
  }

  // 一時停止メニューを開くキー入力を処理する。
  handleInput(input: Input): void {
    if (input.takeKey(K.pauseMenu)) this.toggle();
  }

  // パネルの開閉を切り替える。force を渡すと開閉状態を明示的に指定する。
  toggle(force?: boolean): void {
    const wasOpen = this.panel.style.display === 'block';
    const show = force !== undefined ? force : !wasOpen;
    if (show === wasOpen) return;
    this.panel.style.display = show ? 'block' : 'none';
    syncHudModalState();
    this.onSettingsOpenChange?.(show);
  }

  // BGM スライダーの表示を更新する。
  setBgmVolume(vol: number): void {
    const bgmSlider = this.panel.querySelector<HTMLInputElement>('[data-id="bgmslider"]')!;
    if (bgmSlider) {
      bgmSlider.value = vol.toString();
    }
  }
}
