import { KEY_MAPPING as K } from '../input/key-mapping';
import {
  ACTIVE_THEME_ID, applyThemePalette, getThemePalette, SPACE_4, SPACE_6, THEME_PRESETS,
} from '../theme';
import type { GraphicsSettings } from '../../render/graphics-settings';
import type { DebugTargetHost } from '../../render/pipeline/debug-target';
import { GraphicsPanel } from './graphics-panel';
import type { OverlayHandle, OverlayManager } from './overlay-manager';
import { Button, CloseButton, Slider, TabBar } from './widgets';

type PauseTab = 'general' | 'graphics';

const TAB_ITEMS: readonly (readonly [PauseTab, string])[] = [['general', '一般'], ['graphics', '描画']];

export class PauseMenu implements OverlayHandle {
  private readonly panel: HTMLElement;
  private _isOpen = false;
  // タブごとの中身。表示面の切り替えは .hidden の付け外しだけで行う。
  private readonly faces: ReadonlyMap<PauseTab, HTMLElement>;
  private readonly tabs: TabBar<PauseTab>;

  onPauseMenuOpenChange: ((open: boolean) => void) | null = null;
  onQuitToTitle: (() => void) | null = null;
  onBgmVolumeChange: ((vol: number) => void) | null = null;
  onSave: (() => void) | null = null;
  onOpenSaveBrowser: (() => void) | null = null;
  onOpenPerfWindow: (() => void) | null = null;
  onOpenSettings: (() => void) | null = null;

  private readonly overlayManager: OverlayManager;
  private readonly bgmSlider: Slider;
  private readonly bgmMute: Button;
  // ミュート/復帰を切り替えるための直前の音量。ミュート状態そのものは bgmSlider の値
  // (0 かどうか)から読めるので別に持たない。
  private lastVol = 1;

  // 一般・描画の2面をタブで束ねたパネル DOM を組み立て、BGM・セーブ・セーブデータの管理・
  // 負荷表示・タイトルへ戻るのイベントを配線する。debugTargetHost は描画面の GraphicsPanel が
  // デバッグ表示の選択を書き込む先(RenderPipeline)。
  constructor(
    root: HTMLElement, overlayManager: OverlayManager, graphics: GraphicsSettings, debugTargetHost: DebugTargetHost,
  ) {
    this.overlayManager = overlayManager;
    this.panel = document.createElement('div');
    this.panel.id = 'hud-pause-menu';
    this.panel.className = 'panel';
    const header = document.createElement('div');
    header.className = 'pm-header';
    const heading = document.createElement('h3');
    heading.textContent = '一時停止 / 設定';
    header.appendChild(heading);
    const closeBtn = new CloseButton(() => this.toggle(false));
    header.appendChild(closeBtn.element);
    this.panel.appendChild(header);

    this.tabs = new TabBar<PauseTab>(TAB_ITEMS, (tab) => this.showTab(tab));
    this.panel.appendChild(this.tabs.element);

    const general = document.createElement('div');
    const graphicsPanel = new GraphicsPanel(graphics, debugTargetHost);
    this.faces = new Map([['general', general], ['graphics', graphicsPanel.element]]);
    for (const face of this.faces.values()) this.panel.appendChild(face);

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
    general.appendChild(bgmRow);

    const themeRow = document.createElement('div');
    themeRow.className = 'pm-row pm-theme-row';
    const themeLabel = document.createElement('span');
    themeLabel.className = 'k';
    themeLabel.textContent = '配色';
    themeRow.appendChild(themeLabel);
    const themePreview = document.createElement('span');
    themePreview.className = 'pm-theme-preview';
    themePreview.setAttribute('aria-hidden', 'true');
    const updateThemePreview = (id: string): void => {
      const palette = getThemePalette(id);
      if (!palette) return;
      themePreview.replaceChildren();
      for (const color of [palette.accent, palette.accentNear, palette.secondary]) {
        const swatch = document.createElement('span');
        swatch.className = 'pm-theme-swatch';
        swatch.style.backgroundColor = color;
        themePreview.appendChild(swatch);
      }
    };
    const themeSelect = document.createElement('select');
    themeSelect.className = 'w-input pm-theme-select';
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
    this.panel.appendChild(themeRow);

    const saveRow = document.createElement('div');
    saveRow.className = 'pm-row';
    saveRow.style.marginTop = SPACE_6;
    const saveBtn = new Button('セーブ', () => this.onSave?.());
    saveBtn.element.style.flex = '1';
    saveRow.appendChild(saveBtn.element);
    general.appendChild(saveRow);

    const saveBrowserRow = document.createElement('div');
    saveBrowserRow.className = 'pm-row';
    saveBrowserRow.style.marginTop = SPACE_4;
    const saveBrowserBtn = new Button('セーブデータの管理', () => this.onOpenSaveBrowser?.());
    saveBrowserBtn.element.style.flex = '1';
    saveBrowserRow.appendChild(saveBrowserBtn.element);
    general.appendChild(saveBrowserRow);

    const perfRow = document.createElement('div');
    perfRow.className = 'pm-row';
    perfRow.style.marginTop = SPACE_4;
    const perfBtn = new Button(`負荷を表示 [${K.togglePerfWindow.label}]`, () => this.onOpenPerfWindow?.());
    perfBtn.element.style.flex = '1';
    perfRow.appendChild(perfBtn.element);
    general.appendChild(perfRow);

    const settingsRow = document.createElement('div');
    settingsRow.className = 'pm-row';
    settingsRow.style.marginTop = SPACE_4;
    const settingsBtn = new Button('設定ビューを開く', () => this.onOpenSettings?.());
    settingsBtn.element.style.flex = '1';
    settingsRow.appendChild(settingsBtn.element);
    general.appendChild(settingsRow);

    const quitBtn = new Button('ゲームを中断してタイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('pm-quit');
    general.appendChild(quitBtn.element);

    root.appendChild(this.panel);
    this.showTab('general');
  }

  // 表示面を切り替える。タブの点灯も合わせる。
  private showTab(tab: PauseTab): void {
    for (const [name, face] of this.faces) face.classList.toggle('hidden', name !== tab);
    this.tabs.setSelected(tab);
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
    // タイトル選択画面(#stage-select)は HUD より前面にあるため、タイトル中に
    // メニューを開いたときだけ HUD をその上へ出す。通常のゲーム中は影響しない。
    this.panel.closest<HTMLElement>('#hud')?.classList.toggle(
      'title-menu-open', show && document.getElementById('stage-select') !== null,
    );
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
