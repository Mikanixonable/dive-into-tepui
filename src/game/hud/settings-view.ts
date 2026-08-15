import type { Bgm } from '../../audio/bgm/bgm';
import { BGM_TRACKS } from '../../audio/bgm/tracks/tracks';
import type { OverlayHandle, OverlayManager } from './overlay-manager';
import { Button, CloseButton, Slider } from './widgets';

// タイトル画面とゲーム中の両方から開く、システム設定の共通ビュー。
// 3D の ViewManager とは独立した DOM ビューなので、閉じると開く前のワールドビューへ戻る。
export class SettingsView implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly overlayManager: OverlayManager;
  private readonly bgm: Bgm;
  private _isOpen = false;
  private activeTrack: number | null = null;
  private bgmPlayingAtOpen = false;
  private readonly stopButton: Button;
  private readonly trackButtons: Button[] = [];

  onOpenChange: ((open: boolean) => void) | null = null;

  constructor(root: HTMLElement, overlayManager: OverlayManager, bgm: Bgm) {
    this.overlayManager = overlayManager;
    this.bgm = bgm;

    this.panel = document.createElement('section');
    this.panel.id = 'hud-settings-view';
    this.panel.className = 'panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'hud-settings-title');

    const header = document.createElement('div');
    header.className = 'sv-header';
    const heading = document.createElement('h2');
    heading.id = 'hud-settings-title';
    heading.textContent = '設定';
    header.appendChild(heading);
    const eyebrow = document.createElement('span');
    eyebrow.className = 'sv-eyebrow';
    eyebrow.textContent = 'SYSTEM / SETTINGS';
    header.appendChild(eyebrow);
    this.panel.appendChild(header);

    const description = document.createElement('p');
    description.className = 'sv-description';
    description.textContent = 'ゲームの音量を調整し、航行中に流れるBGMを試聴できます。';
    this.panel.appendChild(description);

    const bgmSection = document.createElement('section');
    bgmSection.className = 'sv-section';
    const bgmTitle = document.createElement('h3');
    bgmTitle.textContent = 'BGM';
    bgmSection.appendChild(bgmTitle);

    const volumeRow = document.createElement('div');
    volumeRow.className = 'sv-volume-row';
    const volumeLabel = document.createElement('span');
    volumeLabel.className = 'sv-label';
    volumeLabel.textContent = '音量';
    volumeRow.appendChild(volumeLabel);
    const volumeValue = document.createElement('span');
    volumeValue.className = 'sv-volume-value';
    const updateVolumeValue = (value: number): void => {
      volumeValue.textContent = `${Math.round(value * 100)}%`;
    };
    const volumeSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (value) => {
      updateVolumeValue(value);
      this.bgm.setVolume(value);
    });
    volumeSlider.setValue(this.bgm.getVolume());
    updateVolumeValue(volumeSlider.getValue());
    volumeRow.appendChild(volumeSlider.element);
    volumeRow.appendChild(volumeValue);
    bgmSection.appendChild(volumeRow);

    const trackList = document.createElement('div');
    trackList.className = 'sv-track-list';
    for (const [index, track] of BGM_TRACKS.entries()) {
      const row = document.createElement('div');
      row.className = 'sv-track-row';
      const trackLabel = document.createElement('div');
      trackLabel.className = 'sv-track-label';
      const number = document.createElement('span');
      number.className = 'sv-track-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.textContent = track.name;
      trackLabel.append(number, name);
      row.appendChild(trackLabel);

      const previewButton = new Button('試聴', () => this.previewTrack(index));
      previewButton.element.classList.add('sv-preview-button');
      this.trackButtons.push(previewButton);
      row.appendChild(previewButton.element);
      trackList.appendChild(row);
    }
    bgmSection.appendChild(trackList);

    const trackActions = document.createElement('div');
    trackActions.className = 'sv-track-actions';
    this.stopButton = new Button('試聴を停止', () => {
      this.bgm.stop(0.15);
      this.activeTrack = null;
      this.updateTrackButtons();
    });
    trackActions.appendChild(this.stopButton.element);
    bgmSection.appendChild(trackActions);
    this.panel.appendChild(bgmSection);

    const footer = document.createElement('div');
    footer.className = 'sv-footer';
    const closeButton = new CloseButton(() => this.toggle(false));
    footer.appendChild(closeButton.element);
    this.panel.appendChild(footer);

    root.appendChild(this.panel);
    this.stopButton.setEnabled(false);
  }

  contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  close(): void {
    this.toggle(false);
  }

  toggle(force?: boolean): void {
    const show = force !== undefined ? force : !this._isOpen;
    if (show === this._isOpen) return;
    this._isOpen = show;
    this.panel.style.display = show ? 'block' : 'none';
    this.panel.closest<HTMLElement>('#hud')?.classList.toggle(
      'title-menu-open', show && document.getElementById('stage-select') !== null,
    );
    if (show) {
      this.bgmPlayingAtOpen = this.bgm.isRunning;
      this.overlayManager.open('settings-view', this, {
        kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true,
        exclusiveGroup: 'system-modal',
      });
    } else {
      this.overlayManager.close('settings-view');
      // 試聴セッションが止めた BGM だけを閉じるときに元へ戻す — 開いた時点で流れていなかったもの
      // (勝敗確定後など)は再開しない。試聴を流したまま閉じたなら、その曲がそのまま流れ続ける。
      if (this.bgmPlayingAtOpen && !this.bgm.isRunning) this.bgm.resume();
      this.activeTrack = null;
      this.updateTrackButtons();
    }
    this.onOpenChange?.(show);
  }

  private previewTrack(index: number): void {
    this.bgm.playTrack(index);
    this.activeTrack = index;
    this.updateTrackButtons();
  }

  private updateTrackButtons(): void {
    for (const [index, button] of this.trackButtons.entries()) {
      const active = index === this.activeTrack;
      button.setOn(active);
      button.setLabel(active ? '再生中' : '試聴');
    }
    this.stopButton.setEnabled(this.activeTrack !== null);
  }
}
