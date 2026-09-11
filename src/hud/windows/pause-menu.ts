import faviconUrl from '../../../public/favicon.svg';
import type { Bgm } from '../../audio/bgm/bgm';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { SPACE_4 } from '../../theme';
import { clampOverlayPosition, Point2 } from '../layout';
import { onViewportChange } from '../viewport';
import { injectOnce } from '../inject-style';
import { injectCommonUiStyle } from '../style/common-ui-style';
import { PAUSE_MENU_STYLE } from '../style/pause-menu-style';
import { SETTINGS_VIEW_STYLE } from '../style/settings-view-style';
import type { OverlayHandle, OverlayManager, OverlaySpec } from '../overlay-manager';
import {
  Button, CloseButton, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, Slider, TabBar,
} from '../widgets';
import { CLICK_MOVE_THRESHOLD } from '../../input/input';
import { SettingsView } from './settings-view';

type PauseMenuTab = 'pause' | 'settings';

// ESCメニュー(#hud-pause-menu)。一時停止操作と詳細設定を外側タブで切り替え、ヘッダーのドラッグ移動と
// 最小化を持つ。
export class PauseMenu implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabContent: HTMLElement;
  private readonly pauseTabPanel: HTMLElement;
  private readonly tabBar: TabBar<PauseMenuTab>;
  // 設定タブへ埋め込んだ設定面。設定の変更の口はこれが持つ。
  private readonly _settingsView: SettingsView;
  public get settingsView(): SettingsView { return this._settingsView; }
  private readonly minimizeToggle: HTMLButtonElement;
  private _isOpen = false;
  private minimized = false;
  private hasCustomPosition = false;
  private activeTab: PauseMenuTab = 'pause';

  public onPauseMenuOpenChange: ((open: boolean) => void) | null = null;
  public onQuitToTitle: (() => void) | null = null;
  public onBgmVolumeChange: ((vol: number) => void) | null = null;
  public onSave: (() => void) | null = null;
  public onOpenSaveBrowser: (() => void) | null = null;
  public onOpenDebugInfoWindow: (() => void) | null = null;

  private readonly overlayManager: OverlayManager;
  private readonly bgmSlider: Slider;
  private readonly bgmMute: Button;
  // ミュート/復帰を切り替えるための直前の音量。ミュート状態そのものは bgmSlider の値
  // (0 かどうか)から読めるので別に持たない。
  private lastVol = 1;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };

  // パネル DOM を組み立てて root へ追加する。graphics と bgmVolume は組み立て時の設定値。
  // 各操作のコールバックは onXxx フィールドへ後から代入する。
  public constructor(
    root: HTMLElement, overlayManager: OverlayManager, bgm: Bgm,
    graphics: GraphicsSettingsData, bgmVolume: number,
  ) {
    injectCommonUiStyle();
    injectOnce('pause-menu', PAUSE_MENU_STYLE);
    injectOnce('settings-view', SETTINGS_VIEW_STYLE);
    this.overlayManager = overlayManager;
    this._settingsView = new SettingsView(bgm, graphics, bgmVolume);
    this.panel = document.createElement('div');
    this.panel.id = 'hud-pause-menu';
    this.panel.className = 'panel ui-surface-focus';

    this.panel.appendChild(this.buildBrand());

    // ヘッダー: 見出し・最小化トグル・✕ ボタンと、ドラッグ移動の配線。
    const header = document.createElement('div');
    header.className = 'pm-header';
    const heading = document.createElement('h3');
    heading.textContent = '一時停止 / 設定';
    header.appendChild(heading);
    this.minimizeToggle = document.createElement('button');
    this.minimizeToggle.type = 'button';
    this.minimizeToggle.className = 'pm-minimize';
    this.minimizeToggle.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.minimizeToggle.addEventListener('click', () => this.setMinimized(!this.minimized));
    const closeBtn = new CloseButton(() => this.toggle(false));
    const headerActions = document.createElement('div');
    headerActions.className = 'pm-header-actions';
    headerActions.appendChild(this.minimizeToggle);
    headerActions.appendChild(closeBtn.element);
    header.appendChild(headerActions);
    header.addEventListener('pointerdown', this.handleHeaderPointerDown);
    header.addEventListener('pointermove', this.handleHeaderPointerMove);
    header.addEventListener('pointerup', this.handleHeaderPointerUp);
    header.addEventListener('pointercancel', this.handleHeaderPointerUp);
    this.panel.appendChild(header);

    this.body = document.createElement('div');
    this.body.className = 'pm-body';
    this.panel.appendChild(this.body);

    this.tabBar = new TabBar<PauseMenuTab>(
      [['pause', '一時停止'], ['settings', '設定']], (tab) => this.setActiveTab(tab),
    );
    this.tabBar.element.classList.add('pm-tabs', 'ui-surface-inset');
    this.body.appendChild(this.tabBar.element);

    this.tabContent = document.createElement('div');
    this.tabContent.className = 'pm-tab-content';
    this.body.appendChild(this.tabContent);

    this.pauseTabPanel = document.createElement('section');
    this.pauseTabPanel.className = 'pm-tab-panel';
    this.pauseTabPanel.setAttribute('role', 'tabpanel');
    this.pauseTabPanel.setAttribute('aria-label', '一時停止');
    this.tabContent.appendChild(this.pauseTabPanel);

    this._settingsView.element.setAttribute('role', 'tabpanel');
    this._settingsView.element.setAttribute('aria-label', '設定');
    this.tabContent.appendChild(this._settingsView.element);
    this.syncMinimizeToggle();

    // 一時停止タブ: BGM 音量行と操作ボタンのグリッド。
    this.bgmSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (vol) => {
      this.updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });
    this.bgmMute = new Button('消音', () => this.toggleMute());
    this.pauseTabPanel.appendChild(this.buildBgmRow());
    this.syncBgmVolume(bgmVolume);
    this.pauseTabPanel.appendChild(this.buildActionGrid());

    root.appendChild(this.panel);
    this.setActiveTab('pause');
    // ビューポート変化のたびに現在位置を収め直す。
    onViewportChange(() => this.reclamp());
  }

  // ロゴ・タイトル・バージョンを ESC メニュー上部へ積む。
  private buildBrand(): HTMLElement {
    const brand = document.createElement('div');
    brand.className = 'pm-brand';
    const brandLogo = document.createElement('img');
    brandLogo.className = 'pm-brand-logo';
    brandLogo.src = faviconUrl;
    brandLogo.alt = '';
    brand.appendChild(brandLogo);
    const brandText = document.createElement('div');
    brandText.className = 'pm-brand-text';
    const brandTitle = document.createElement('span');
    brandTitle.className = 'pm-brand-title';
    brandTitle.textContent = 'Dive into Tepui';
    brandText.appendChild(brandTitle);
    const brandVersion = document.createElement('span');
    brandVersion.className = 'pm-brand-version';
    brandVersion.textContent = `v${__APP_VERSION__}`;
    brandText.appendChild(brandVersion);
    brand.appendChild(brandText);
    return brand;
  }

  // ラベル・音量スライダー・消音ボタンを1行に並べる。
  private buildBgmRow(): HTMLElement {
    const bgmRow = document.createElement('div');
    bgmRow.className = 'pm-row';
    const bgmLabel = document.createElement('span');
    bgmLabel.className = 'k';
    bgmLabel.textContent = 'BGM Vol';
    bgmRow.appendChild(bgmLabel);
    // スライダーが残りの幅を取り、消音ボタンは右端に寄る。
    this.bgmSlider.element.style.flex = '1';
    this.bgmSlider.element.style.marginLeft = SPACE_4;
    bgmRow.appendChild(this.bgmSlider.element);
    this.bgmMute.element.style.marginLeft = SPACE_4;
    bgmRow.appendChild(this.bgmMute.element);
    return bgmRow;
  }

  // セーブ・セーブデータ管理・デバッグ表示の導線と、タイトルへ戻るボタンを並べる。幅を使って
  // 2列に詰められるよう、操作行だけを専用のグリッドへまとめる。
  private buildActionGrid(): HTMLElement {
    const actionGrid = document.createElement('div');
    actionGrid.className = 'pm-actions';
    // 幅いっぱいのボタン1つだけを持つ行を足す。
    const addButtonRow = (label: string, onClick: () => void): void => {
      const row = document.createElement('div');
      row.className = 'pm-row';
      const btn = new Button(label, onClick);
      btn.element.classList.add('pm-menu-btn');
      btn.element.style.flex = '1';
      row.appendChild(btn.element);
      actionGrid.appendChild(row);
    };
    addButtonRow('セーブ', () => this.onSave?.());
    addButtonRow('セーブデータの管理', () => this.onOpenSaveBrowser?.());
    addButtonRow(`デバッグを表示 [${K.toggleDebugInfoWindow.label}]`, () => this.onOpenDebugInfoWindow?.());

    const quitBtn = new Button('ゲームを中断してタイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('pm-menu-btn', 'pm-quit');
    actionGrid.appendChild(quitBtn.element);
    return actionGrid;
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

  // 最小化状態を切り替える。パネルを閉じて再び開くと展開状態から始まる。
  private setMinimized(minimized: boolean): void {
    this.minimized = minimized;
    this.body.classList.toggle('hidden', minimized);
    this.syncMinimizeToggle();
    this.reclamp();
  }

  // 外側タブを切り替え、設定面の試聴と入力ゲートも同じ状態へ合わせる。
  private setActiveTab(tab: PauseMenuTab): void {
    this.activeTab = tab;
    this.tabBar.setSelected(tab);
    this.pauseTabPanel.hidden = tab !== 'pause';
    this._settingsView.element.hidden = tab !== 'settings';
    this._settingsView.setActive(tab === 'settings');
    if (this._isOpen) this.overlayManager.reconfigure('pause-menu', this.overlaySpec());
    this.reclamp();
  }

  // タブに応じた ESC メニューの入力遮断設定を返す。
  private overlaySpec(): OverlaySpec {
    return {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: this.activeTab === 'settings', dimsBackground: false,
      exclusiveGroup: 'system-modal',
    };
  }

  // 最小化トグルボタンの絵文字・aria-expanded・title を現在の折りたたみ状態に合わせる。
  private syncMinimizeToggle(): void {
    this.minimizeToggle.textContent = this.minimized ? COLLAPSE_COLLAPSED_GLYPH : COLLAPSE_EXPANDED_GLYPH;
    this.minimizeToggle.setAttribute('aria-expanded', String(!this.minimized));
    this.minimizeToggle.title = this.minimized ? '展開する' : '最小化する';
  }

  // OverlayHandle 実装。target がパネル要素の内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // OverlayHandle 実装。ESC で閉じる際も toggle(false) と等価に扱う。
  public close(): void {
    this.toggle(false);
  }

  // タイトル画面などの設定導線から、ESC メニューの設定タブを開く。
  public openSettings(): void {
    this.toggle(true);
    this.setMinimized(false);
    this.setActiveTab('settings');
  }

  // パネルの開閉を切り替える。force を渡すと開閉状態を明示的に指定する。
  public toggle(force?: boolean): void {
    const show = force !== undefined ? force : !this._isOpen;
    if (show === this._isOpen) return;
    if (!show) this.setActiveTab('pause');
    this._isOpen = show;
    this.panel.style.display = show ? 'flex' : 'none';
    if (show) {
      this.setActiveTab('pause');
      this.setMinimized(false);
      if (!this.hasCustomPosition) this.centerPanel();
      this.overlayManager.open('pause-menu', this, this.overlaySpec());
    } else {
      this.overlayManager.close('pause-menu');
    }
    this.onPauseMenuOpenChange?.(show);
  }

  // 画面中央へ配置する。
  private centerPanel(): void {
    const rect = this.panel.getBoundingClientRect();
    this.moveTo((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
  }

  // 要求座標をビューポート内へクランプして配置する。
  private moveTo(clientX: number, clientY: number): void {
    const rect = this.panel.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.panel.style.left = `${pos.x}px`;
    this.panel.style.top = `${pos.y}px`;
  }

  // 現在位置をビューポート内へ収め直す。
  private reclamp(): void {
    if (!this._isOpen) return;
    this.moveTo(this.panel.offsetLeft, this.panel.offsetTop);
  }

  // ヘッダー上のボタン以外を掴んだときに、ドラッグ開始点とポインタキャプチャを確保する。
  private handleHeaderPointerDown = (e: PointerEvent): void => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    this.dragPointerId = e.pointerId;
    this.dragStartClient = { x: e.clientX, y: e.clientY };
    this.dragStartWindowPos = { x: this.panel.offsetLeft, y: this.panel.offsetTop };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // しきい値(CLICK_MOVE_THRESHOLD)を超えて動いたら位置を持ち出し位置として確定させる。
  private handleHeaderPointerMove = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId || this.dragStartClient === null) return;
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    if (!this.hasCustomPosition && Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
    this.hasCustomPosition = true;
    this.moveTo(this.dragStartWindowPos.x + dx, this.dragStartWindowPos.y + dy);
  };

  // ポインタキャプチャを解放してドラッグ状態を終える。
  private handleHeaderPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.dragPointerId = null;
    this.dragStartClient = null;
  };

  // 外から音量が変わったときに、スライダーと消音ボタンの点灯を引き直す。
  public syncBgmVolume(vol: number): void {
    this.bgmSlider.setValue(vol);
    this.updateMuteState(vol);
  }
}
