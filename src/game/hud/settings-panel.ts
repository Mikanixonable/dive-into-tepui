import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import * as C from '../const';
import { syncHudModalState } from './dom';
import { WARNING, ACCENT_SOFT } from '../theme';

export class SettingsPanel {
  private readonly panel: HTMLElement;


  onSettingsOpenChange: ((open: boolean) => void) | null = null;
  onQuitToTitle: (() => void) | null = null;
  onBgmVolumeChange: ((vol: number) => void) | null = null;
  onSaveGame: (() => void) | null = null;
  onLoadGame: (() => void) | null = null;

  // ⚙ ボタンとパネル DOM を組み立て、開閉・BGM トグル・タイトルへ戻るのイベントを配線する。
  constructor(root: HTMLElement) {

    // パネル本体
    this.panel = document.createElement('div');
    this.panel.id = 'hud-settings';
    this.panel.className = 'panel';
    this.panel.innerHTML = `
      <h3>一時停止 / 設定</h3>
      <div class="srow">
        <span class="k">BGM Vol</span>
        <input type="range" data-id="bgmslider" min="0" max="1" step="0.05" value="1" style="flex:1; margin-left: 10px; cursor: pointer; accent-color: ${C.COLOR_ACCENT};">
        <div class="stoggle" data-id="bgmmute" style="margin-left: 10px;">消音</div>
      </div>
      <div class="srow" style="margin-top: 20px;">
        <button data-id="savebtn" class="settings-btn" style="flex:1; margin-right: 5px;">セーブ</button>
        <button data-id="loadbtn" class="settings-btn" style="flex:1; margin-left: 5px;">ロード</button>
      </div>
      <div data-id="savestatus" style="text-align: center; font-size: 10px; color: ${C.COLOR_ACCENT_SOFT}; height: 14px; margin-top: 4px;"></div>
      <div class="squit" data-id="settingsquit">ゲームを中断してタイトル画面に戻る</div>
      <div class="sclose" data-id="settingsclose">[閉じる]</div>`;
    root.appendChild(this.panel);

    // BGM スライダーと消音トグル
    const bgmSlider = this.panel.querySelector<HTMLInputElement>('[data-id="bgmslider"]')!;
    const bgmMute = this.panel.querySelector<HTMLElement>('[data-id="bgmmute"]')!;
    let lastVol = 1;
    let isMuted = false;

    const updateMuteState = (vol: number) => {
      if (vol > 0) {
        isMuted = false;
        bgmMute.classList.remove('on');
      } else {
        isMuted = true;
        bgmMute.classList.add('on');
      }
    };

    bgmSlider.addEventListener('input', () => {
      const vol = parseFloat(bgmSlider.value);
      updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });

    bgmMute.addEventListener('click', () => {
      if (isMuted) {
        bgmSlider.value = lastVol.toString();
        isMuted = false;
        bgmMute.classList.remove('on');
      } else {
        lastVol = parseFloat(bgmSlider.value) || 1;
        bgmSlider.value = '0';
        isMuted = true;
        bgmMute.classList.add('on');
      }
      this.onBgmVolumeChange?.(parseFloat(bgmSlider.value));
    });
    // タイトルへ戻る
    this.panel.querySelector<HTMLElement>('[data-id="settingsquit"]')!.addEventListener('click', () => {
      this.onQuitToTitle?.();
    });
    // セーブ・ロード
    this.panel.querySelector<HTMLElement>('[data-id="savebtn"]')!.addEventListener('click', () => {
      this.onSaveGame?.();
    });
    this.panel.querySelector<HTMLElement>('[data-id="loadbtn"]')!.addEventListener('click', () => {
      this.onLoadGame?.();
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

  // message を3秒間だけステータス行に表示する。
  showSaveStatus(message: string, isError = false): void {
    const status = this.panel.querySelector<HTMLElement>('[data-id="savestatus"]')!;
    status.textContent = message;
    status.style.color = isError ? WARNING : ACCENT_SOFT;
    setTimeout(() => {
      if (status.textContent === message) status.textContent = '';
    }, 3000);
  }
}
