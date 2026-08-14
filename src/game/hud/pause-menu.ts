import { KEY_MAPPING as K } from '../input/key-mapping';
import {
  ACTIVE_THEME_ID, persistThemePalette, SPACE_4, SPACE_6, THEME_PRESETS,
} from '../theme';
import type { OverlayHandle, OverlayManager } from './overlay-manager';
import { Button, CloseButton, Slider } from './widgets';

export class PauseMenu implements OverlayHandle {
  private readonly panel: HTMLElement;
  private _isOpen = false;

  onPauseMenuOpenChange: ((open: boolean) => void) | null = null;
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
  constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-pause-menu';
    this.panel.className = 'panel';
    const heading = document.createElement('h3');
    heading.textContent = '一時停止 / 設定';
    this.panel.appendChild(heading);

    const bgmRow = document.createElement('div');
    bgmRow.className = 'pm-row';
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

    const themeRow = document.createElement('div');
    themeRow.className = 'pm-row pm-theme-row';
    const themeLabel = document.createElement('span');
    themeLabel.className = 'k';
    themeLabel.textContent = '配色';
    themeRow.appendChild(themeLabel);
    const themeSelect = document.createElement('select');
    themeSelect.className = 'w-input pm-theme-select';
    themeSelect.setAttribute('aria-label', '配色プリセット');
    for (const palette of THEME_PRESETS) {
      const option = document.createElement('option');
      option.value = palette.id;
      option.textContent = palette.name;
      option.title = palette.description;
      themeSelect.appendChild(option);
    }
    themeSelect.value = ACTIVE_THEME_ID;
    themeSelect.addEventListener('change', () => {
      if (!persistThemePalette(themeSelect.value)) {
        themeSelect.value = ACTIVE_THEME_ID;
        return;
      }
      // CSS/タイトル3Dマテリアルは起動時にテーマ値を取り込むため、再読込で全画面へ反映する。
      location.reload();
    });
    themeRow.appendChild(themeSelect);
    this.panel.appendChild(themeRow);

    const snapshotRow = document.createElement('div');
    snapshotRow.className = 'pm-row';
    snapshotRow.style.marginTop = SPACE_6;
    const snapshotBtn = new Button('スナップショット', () => this.onOpenSnapshots?.());
    snapshotBtn.element.style.flex = '1';
    snapshotRow.appendChild(snapshotBtn.element);
    this.panel.appendChild(snapshotRow);

    const perfRow = document.createElement('div');
    perfRow.className = 'pm-row';
    perfRow.style.marginTop = SPACE_4;
    const perfBtn = new Button(`負荷を表示 [${K.togglePerfWindow.label}]`, () => this.onOpenPerfWindow?.());
    perfBtn.element.style.flex = '1';
    perfRow.appendChild(perfBtn.element);
    this.panel.appendChild(perfRow);

    const quitBtn = new Button('ゲームを中断してタイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('pm-quit');
    this.panel.appendChild(quitBtn.element);

    const closeRow = document.createElement('div');
    closeRow.className = 'pm-close-row';
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

  contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // OverlayHandle 実装。ESC で閉じる際も toggle(false) と等価に扱う。
  close(): void {
    this.toggle(false);
  }

  // パネルの開閉を切り替える。force を渡すと開閉状態を明示的に指定する。
  toggle(force?: boolean): void {
    const show = force !== undefined ? force : !this._isOpen;
    if (show === this._isOpen) return;
    this._isOpen = show;
    this.panel.style.display = show ? 'block' : 'none';
    if (show) {
      // ESCメニュー表示中も、背景のマップ切替とカメラ操作は受け付ける(gatesInput: false)。
      this.overlayManager.open('pause-menu', this, {
        kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false,
        exclusiveGroup: 'system-modal',
      });
    } else {
      this.overlayManager.close('pause-menu');
    }
    this.onPauseMenuOpenChange?.(show);
  }

  // BGM スライダーの表示を更新する。
  setBgmVolume(vol: number): void {
    this.bgmSlider.setValue(vol);
    this.updateMuteState(vol);
  }
}
