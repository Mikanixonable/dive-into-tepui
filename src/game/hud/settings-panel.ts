import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ACCENT, SPACE_4, SPACE_6 } from '../theme';
import type { ModalController } from './modal-controller';

export class SettingsPanel {
  private readonly panel: HTMLElement;


  onSettingsOpenChange: ((open: boolean) => void) | null = null;
  onQuitToTitle: (() => void) | null = null;
  onBgmVolumeChange: ((vol: number) => void) | null = null;
  onOpenSnapshots: (() => void) | null = null;
  onOpenPerfWindow: (() => void) | null = null;

  // ⚙ ボタンとパネル DOM を組み立て、開閉・BGM トグル・タイトルへ戻るのイベントを配線する。
  constructor(root: HTMLElement, private readonly modalController: ModalController) {

    // パネル本体
    this.panel = document.createElement('div');
    this.panel.id = 'hud-settings';
    this.panel.className = 'panel';
    this.panel.innerHTML = `
      <h3>一時停止 / 設定</h3>
      <div class="srow">
        <span class="k">BGM Vol</span>
        <input type="range" data-id="bgmslider" min="0" max="1" step="0.05" value="1" style="flex:1; margin-left: ${SPACE_4}; cursor: pointer; accent-color: ${ACCENT};">
        <div class="stoggle" data-id="bgmmute" style="margin-left: ${SPACE_4};">消音</div>
      </div>
      <div class="srow" style="margin-top: ${SPACE_6};">
        <button data-id="snapshotbtn" class="settings-btn" style="flex:1;">スナップショット</button>
      </div>
      <div class="srow" style="margin-top: ${SPACE_4};">
        <button data-id="perfbtn" class="settings-btn" style="flex:1;">負荷を表示 [${K.togglePerfWindow.label}]</button>
      </div>
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
    // スナップショット一覧
    this.panel.querySelector<HTMLElement>('[data-id="snapshotbtn"]')!.addEventListener('click', () => {
      this.onOpenSnapshots?.();
    });
    // 負荷確認ウィンドウ
    this.panel.querySelector<HTMLElement>('[data-id="perfbtn"]')!.addEventListener('click', () => {
      this.onOpenPerfWindow?.();
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
    // ESCメニュー表示中も、背景のマップ切替とカメラ操作は受け付ける。
    this.modalController.setOpen('settings', show, true);
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
