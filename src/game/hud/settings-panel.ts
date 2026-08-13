import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { SPACE_4, SPACE_6 } from '../theme';
import type { ModalController } from './modal-controller';
import { Button, CloseButton, Slider } from './widgets';

export class SettingsPanel {
  private readonly panel: HTMLElement;

  onSettingsOpenChange: ((open: boolean) => void) | null = null;
  onQuitToTitle: (() => void) | null = null;
  onBgmVolumeChange: ((vol: number) => void) | null = null;
  onOpenSnapshots: (() => void) | null = null;
  onOpenPerfWindow: (() => void) | null = null;

  private readonly bgmSlider: Slider;
  private readonly bgmMute: Button;
  // ミュート/復帰を切り替えるための直前の音量。ミュート状態そのものは bgmSlider の値
  // (0 かどうか)から読めるので別に持たない。
  private lastVol = 1;

  // ⚙ ボタンとパネル DOM を組み立て、開閉・BGM トグル・タイトルへ戻るのイベントを配線する。
  constructor(root: HTMLElement, private readonly modalController: ModalController) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-settings';
    this.panel.className = 'panel';
    const heading = document.createElement('h3');
    heading.textContent = '一時停止 / 設定';
    this.panel.appendChild(heading);

    const bgmRow = document.createElement('div');
    bgmRow.className = 'srow';
    const bgmLabel = document.createElement('span');
    bgmLabel.className = 'k';
    bgmLabel.textContent = 'BGM Vol';
    bgmRow.appendChild(bgmLabel);
    this.bgmSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (vol) => {
      this.updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });
    this.bgmSlider.setValue(1);
    this.bgmSlider.element.style.flex = '1';
    this.bgmSlider.element.style.marginLeft = SPACE_4;
    bgmRow.appendChild(this.bgmSlider.element);
    this.bgmMute = new Button('消音', () => this.toggleMute());
    this.bgmMute.element.style.marginLeft = SPACE_4;
    bgmRow.appendChild(this.bgmMute.element);
    this.panel.appendChild(bgmRow);

    const snapshotRow = document.createElement('div');
    snapshotRow.className = 'srow';
    snapshotRow.style.marginTop = SPACE_6;
    const snapshotBtn = new Button('スナップショット', () => this.onOpenSnapshots?.());
    snapshotBtn.element.style.flex = '1';
    snapshotRow.appendChild(snapshotBtn.element);
    this.panel.appendChild(snapshotRow);

    const perfRow = document.createElement('div');
    perfRow.className = 'srow';
    perfRow.style.marginTop = SPACE_4;
    const perfBtn = new Button(`負荷を表示 [${K.togglePerfWindow.label}]`, () => this.onOpenPerfWindow?.());
    perfBtn.element.style.flex = '1';
    perfRow.appendChild(perfBtn.element);
    this.panel.appendChild(perfRow);

    const quitBtn = new Button('ゲームを中断してタイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('squit');
    this.panel.appendChild(quitBtn.element);

    const closeRow = document.createElement('div');
    closeRow.className = 'sclose-row';
    const closeBtn = new CloseButton(() => this.toggle(false));
    closeRow.appendChild(closeBtn.element);
    this.panel.appendChild(closeRow);

    root.appendChild(this.panel);
  }

  // ミュート/復帰を切り替える。復帰は直前の音量へ戻す。
  private toggleMute(): void {
    if (this.bgmSlider.getValue() > 0) {
      this.lastVol = this.bgmSlider.getValue();
      this.bgmSlider.setValue(0);
    } else {
      this.bgmSlider.setValue(this.lastVol || 1);
    }
    this.updateMuteState(this.bgmSlider.getValue());
    this.onBgmVolumeChange?.(this.bgmSlider.getValue());
  }

  // 消音ボタンの点灯を音量から合わせる。
  private updateMuteState(vol: number): void {
    this.bgmMute.setOn(vol <= 0);
  }

  // 一時停止メニューを開くキー入力を処理する。スナップショット一覧が開いている間は
  // [Esc] をそちらの「閉じる」操作に譲る。
  handleInput(input: Input): void {
    if (this.modalController.isModalOpen('save-browser')) return;
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
    this.bgmSlider.setValue(vol);
    this.updateMuteState(vol);
  }
}
