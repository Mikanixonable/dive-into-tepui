import type { Bgm } from '../../audio/bgm/bgm';
import { BGM_TRACKS } from '../../audio/bgm/tracks/tracks';
import type { GraphicsSettings } from '../../render/graphics-settings';
import type { DebugTargetHost } from '../../render/pipeline/debug-target';
import { ACTIVE_THEME_ID, applyThemePalette, getThemePalette, THEME_PRESETS } from '../theme';
import { GraphicsPanel } from './graphics-panel';
import type { OverlayHandle, OverlayManager } from './overlay-manager';
import { Button, CloseButton, Slider, TabBar } from './widgets';

type SettingsTab = 'music' | 'graphics';

const TAB_ITEMS: readonly (readonly [SettingsTab, string])[] = [['music', '音楽'], ['graphics', '描画']];

// タイトル画面とゲーム中の両方から開く、システム設定の共通ビュー。
// 3D の ViewManager とは独立した DOM ビューなので、閉じると開く前のワールドビューへ戻る。
// debugTargetHost は「描画」タブの GraphicsPanel がデバッグ表示の選択を書き込む先(RenderPipeline)。
export class SettingsView implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly overlayManager: OverlayManager;
  private readonly bgm: Bgm;
  private _isOpen = false;
  private activeTrack: number | null = null;
  private readonly stopButton: Button;
  private readonly trackButtons: Button[] = [];
  // タブごとの中身。表示面の切り替えは .hidden の付け外しだけで行う。
  private readonly faces: ReadonlyMap<SettingsTab, HTMLElement>;
  private readonly tabs: TabBar<SettingsTab>;

  onOpenChange: ((open: boolean) => void) | null = null;

  constructor(
    root: HTMLElement, overlayManager: OverlayManager, bgm: Bgm, graphics: GraphicsSettings, debugTargetHost: DebugTargetHost,
  ) {
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

    this.tabs = new TabBar<SettingsTab>(TAB_ITEMS, (tab) => this.showTab(tab));
    this.panel.appendChild(this.tabs.element);

    const musicFace = document.createElement('div');
    const graphicsFace = document.createElement('div');
    this.faces = new Map([['music', musicFace], ['graphics', graphicsFace]]);
    for (const face of this.faces.values()) this.panel.appendChild(face);

    const themeRow = document.createElement('div');
    themeRow.className = 'sv-row sv-theme-row';
    const themeLabel = document.createElement('span');
    themeLabel.className = 'sv-label';
    themeLabel.textContent = '配色';
    themeRow.appendChild(themeLabel);
    const themePreview = document.createElement('span');
    themePreview.className = 'sv-theme-preview';
    themePreview.setAttribute('aria-hidden', 'true');
    const updateThemePreview = (id: string): void => {
      const palette = getThemePalette(id);
      if (!palette) return;
      themePreview.replaceChildren();
      for (const color of [palette.accent, palette.accentNear, palette.secondary]) {
        const swatch = document.createElement('span');
        swatch.className = 'sv-theme-swatch';
        swatch.style.backgroundColor = color;
        themePreview.appendChild(swatch);
      }
    };
    const themeSelect = document.createElement('select');
    themeSelect.className = 'w-input sv-theme-select';
    themeSelect.setAttribute('aria-label', '配色プリセット');
    for (const palette of THEME_PRESETS) {
      const option = document.createElement('option');
      option.value = palette.id;
      option.textContent = `● ${palette.name}`;
      option.style.color = palette.accent;
      option.title = palette.description;
      themeSelect.appendChild(option);
    }
    themeSelect.value = ACTIVE_THEME_ID;
    updateThemePreview(themeSelect.value);
    themeSelect.addEventListener('change', () => {
      if (!applyThemePalette(themeSelect.value)) {
        themeSelect.value = ACTIVE_THEME_ID;
        return;
      }
      updateThemePreview(themeSelect.value);
    });
    themeRow.appendChild(themePreview);
    themeRow.appendChild(themeSelect);
    graphicsFace.appendChild(themeRow);

    const graphicsPanel = new GraphicsPanel(graphics, debugTargetHost);
    graphicsFace.appendChild(graphicsPanel.element);

    const description = document.createElement('p');
    description.className = 'sv-description';
    description.textContent = 'ゲームの音量を調整し、航行中に流れるBGMを試聴できます。';
    musicFace.appendChild(description);

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
      this.bgm.stopAudition();
      this.activeTrack = null;
      this.updateTrackButtons();
    });
    trackActions.appendChild(this.stopButton.element);
    bgmSection.appendChild(trackActions);
    musicFace.appendChild(bgmSection);

    const footer = document.createElement('div');
    footer.className = 'sv-footer';
    const closeButton = new CloseButton(() => this.toggle(false));
    footer.appendChild(closeButton.element);
    this.panel.appendChild(footer);

    root.appendChild(this.panel);
    this.stopButton.setEnabled(false);
    this.showTab('music');
  }

  // 表示面を切り替える。タブの点灯も合わせる。
  private showTab(tab: SettingsTab): void {
    for (const [name, face] of this.faces) face.classList.toggle('hidden', name !== tab);
    this.tabs.setSelected(tab);
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
    // 開いている間はゲーム中の BGM を伏せ、試聴だけが聞こえる状態にする。閉じたら試聴の線を
    // 畳んでゲーム側を戻す — 開いた時点で鳴っていなければ、戻しても無音のまま。
    if (show) {
      this.bgm.beginAudition();
      this.overlayManager.open('settings-view', this, {
        kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true,
        exclusiveGroup: 'system-modal',
      });
    } else {
      this.overlayManager.close('settings-view');
      this.bgm.endAudition();
      this.activeTrack = null;
      this.updateTrackButtons();
    }
    this.onOpenChange?.(show);
  }

  private previewTrack(index: number): void {
    this.bgm.playAudition(index);
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
