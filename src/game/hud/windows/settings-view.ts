import faviconUrl from '../../../../public/favicon.svg';
import type { Bgm } from '../../../audio/bgm/bgm';
import { BGM_TRACKS } from '../../../audio/bgm/tracks/tracks';
import type { GraphicsSettings } from '../../../render/graphics-settings';
import {
  applyThemePalette, currentThemePalette, THEME_PRESETS,
} from '../../theme';
import { GraphicsPanel } from '../panels/graphics-panel';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { Button, CloseButton, Slider, TabBar } from '../widgets';

type SettingsTab = 'theme' | 'graphics' | 'bgm';

// タイトル画面とゲーム中の両方から開く、システム設定の共通ビュー。
// 3D の ViewManager とは独立した DOM ビューなので、閉じると開く前のワールドビューへ戻る。
export class SettingsView implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly overlayManager: OverlayManager;
  private readonly bgm: Bgm;
  private _isOpen = false;
  private activeTrack: number | null = null;
  private readonly stopButton: Button;
  private readonly trackButtons: Button[] = [];

  onOpenChange: ((open: boolean) => void) | null = null;

  constructor(
    root: HTMLElement, overlayManager: OverlayManager, bgm: Bgm, graphics: GraphicsSettings,
  ) {
    this.overlayManager = overlayManager;
    this.bgm = bgm;

    this.panel = document.createElement('section');
    this.panel.id = 'hud-settings-view';
    this.panel.className = 'panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'hud-settings-title');

    const brand = document.createElement('div');
    brand.className = 'sv-brand';
    const brandLogo = document.createElement('img');
    brandLogo.className = 'sv-brand-logo';
    brandLogo.src = faviconUrl;
    brandLogo.alt = '';
    brand.appendChild(brandLogo);
    const brandText = document.createElement('div');
    brandText.className = 'sv-brand-text';
    const brandTitle = document.createElement('span');
    brandTitle.className = 'sv-brand-title';
    brandTitle.textContent = 'Dive into Tepui';
    brandText.appendChild(brandTitle);
    const brandVersion = document.createElement('span');
    brandVersion.className = 'sv-brand-version';
    brandVersion.textContent = `v${__APP_VERSION__}`;
    brandText.appendChild(brandVersion);
    brand.appendChild(brandText);
    this.panel.appendChild(brand);

    const header = document.createElement('div');
    header.className = 'sv-header';
    const headingGroup = document.createElement('div');
    headingGroup.className = 'sv-heading-group';
    const heading = document.createElement('h2');
    heading.id = 'hud-settings-title';
    heading.textContent = '設定';
    headingGroup.appendChild(heading);
    const eyebrow = document.createElement('span');
    eyebrow.className = 'sv-eyebrow';
    eyebrow.textContent = 'SYSTEM / SETTINGS';
    headingGroup.appendChild(eyebrow);
    header.appendChild(headingGroup);
    const closeButton = new CloseButton(() => this.toggle(false));
    header.appendChild(closeButton.element);
    this.panel.appendChild(header);

    const description = document.createElement('p');
    description.className = 'sv-description';
    description.textContent = '配色・描画・BGMの設定を切り替えられます。';
    this.panel.appendChild(description);

    const tabPanels = new Map<SettingsTab, HTMLElement>();
    const tabs = new TabBar<SettingsTab>(
      [['theme', '配色'], ['graphics', '描画'], ['bgm', 'BGM']],
      (selectedTab) => {
        tabs.setSelected(selectedTab);
        for (const [tab, panel] of tabPanels) panel.hidden = tab !== selectedTab;
      },
    );
    tabs.element.classList.add('sv-tabs');
    this.panel.appendChild(tabs.element);

    const addTabPanel = (tab: SettingsTab, title: string): HTMLElement => {
      const section = document.createElement('section');
      section.className = 'sv-section sv-tab-panel';
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-label', title);
      section.hidden = true;
      const sectionTitle = document.createElement('h3');
      sectionTitle.textContent = title;
      section.appendChild(sectionTitle);
      tabPanels.set(tab, section);
      return section;
    };

    const themePanel = addTabPanel('theme', '配色');
    const themeOptions = document.createElement('div');
    themeOptions.className = 'sv-theme-options';
    const themeButtons = new Map<string, Button>();
    let activeThemeId = currentThemePalette().id;
    for (const palette of THEME_PRESETS) {
      const previewColors = [palette.page, palette.surface1, palette.title, palette.accent, palette.signal];
      const preview = `<span class="sv-theme-preview">${previewColors
        .map((color) => `<span class="sv-theme-swatch" style="background-color: ${color}"></span>`)
        .join('')}</span>`;
      const themeButton = new Button(
        palette.name,
        () => {
          if (!applyThemePalette(palette.id)) return;
          activeThemeId = palette.id;
          for (const [id, button] of themeButtons) button.setOn(id === activeThemeId);
        },
        `<span class="sv-theme-icon">${preview}</span>`,
      );
      themeButton.element.classList.add('sv-theme-button');
      themeButton.element.style.setProperty('--sv-theme-page', palette.page);
      themeButton.element.style.setProperty('--sv-theme-title', palette.title);
      themeButton.element.title = palette.description;
      themeButton.element.setAttribute('aria-label', `${palette.name}: ${palette.description}`);
      themeButtons.set(palette.id, themeButton);
      themeOptions.appendChild(themeButton.element);
    }
    for (const [id, button] of themeButtons) button.setOn(id === activeThemeId);
    themePanel.appendChild(themeOptions);
    this.panel.appendChild(themePanel);

    const graphicsSection = addTabPanel('graphics', '描画');
    const graphicsPanel = new GraphicsPanel(graphics);
    graphicsSection.appendChild(graphicsPanel.element);
    this.panel.appendChild(graphicsSection);

    const bgmSection = addTabPanel('bgm', 'BGM');

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
    this.panel.appendChild(bgmSection);

    tabs.setSelected('theme');
    const initialPanel = tabPanels.get('theme');
    if (initialPanel !== undefined) initialPanel.hidden = false;

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
