import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { placeOverlayAt } from '../layout';
import { onViewportChange } from '../viewport';
import { injectOnce } from '../inject-style';
import { injectCommonUiStyle } from '../style/common-ui-style';
import { injectTitleLogotypeStyle, TITLE_LOGOTYPE_HTML } from '../title-logotype';
import { PAUSE_MENU_STYLE } from '../style/pause-menu-style';
import { SETTINGS_VIEW_STYLE } from '../style/settings-view-style';
import { SYSTEM_MODAL_GROUP } from '../overlay-manager';
import type { OverlayHandle, OverlayManager, SurfaceSpec } from '../overlay-manager';
import {
  Button, CloseButton, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, Slider, TabBar,
  type ButtonVariant,
} from '../widgets';
import { wireHeaderDrag } from '../window-drag';
import { SettingsView } from './settings-view';

type PauseMenuTab = 'pause' | 'settings';

// OverlayManager の台帳上の id。開いているかどうかは登録の有無が正本。
const OVERLAY_ID = 'pause-menu';

const TAB_LABELS: readonly (readonly [PauseMenuTab, string])[] = [['pause', '一時停止'], ['settings', '設定']];

// 消音ボタンの絵。消音中(.on)は音の波が消えて斜線が出る。
const SPEAKER_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M2 6h3l4-3.5v11L5 10H2z" fill="currentColor"/>'
  + '<path class="pm-speaker-waves" d="M11.5 5.5a3.5 3.5 0 010 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
  + '<path class="pm-speaker-slash" d="M11 5.5l4 5M15 5.5l-4 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

// ESCメニュー(#hud-pause-menu)。一時停止操作と詳細設定を外側タブで切り替え、ロゴの列とタブの行からのドラッグ移動と
// 最小化を持つ。
export class PauseMenu implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabContent: HTMLElement;
  private readonly pauseTabPanel: HTMLElement;
  private readonly tabBar: TabBar<PauseMenuTab>;
  // 設定タブに配置された設定ビュー。設定変更の操作を受け持つ。
  private readonly _settingsView: SettingsView;
  public get settingsView(): SettingsView { return this._settingsView; }
  private readonly minimizeToggle: Button;
  private minimized = false;
  private hasCustomPosition = false;
  private activeTab: PauseMenuTab = 'pause';

  public onQuitToTitle: (() => void) | null = null;
  public onBgmVolumeChange: ((vol: number) => void) | null = null;
  // 消音ボタンが押されたときに、求められた消音の有無を渡して呼ばれる。
  public onBgmMutedChange: ((muted: boolean) => void) | null = null;
  public onSave: (() => void) | null = null;
  public onOpenSaveBrowser: (() => void) | null = null;
  public onOpenDebugInfoWindow: (() => void) | null = null;

  private readonly overlayManager: OverlayManager;
  private readonly resizeObserver: ResizeObserver;
  private readonly bgmSlider: Slider;
  private readonly bgmMute: Button;
  private readonly bgmValue: HTMLElement;

  // パネル DOM を組み立てる。要素は開くまで DOM へ挿さず、overlayManager が modal の層へ置く。
  // graphics・themeId は組み立て時の設定値、bgmVolume は消音を織り込んだ組み立て時の音量。
  // 各操作のコールバックは onXxx フィールドへ後から代入する。
  public constructor(
    overlayManager: OverlayManager,
    graphics: GraphicsSettingsData, bgmVolume: number, themeId: string,
  ) {
    injectCommonUiStyle();
    injectTitleLogotypeStyle();
    injectOnce('pause-menu', PAUSE_MENU_STYLE);
    injectOnce('settings-view', SETTINGS_VIEW_STYLE);
    this.overlayManager = overlayManager;
    this._settingsView = new SettingsView(graphics, bgmVolume, themeId);
    this.panel = document.createElement('div');
    this.panel.id = 'hud-pause-menu';
    this.panel.className = 'panel ui-surface-focus';

    // 左の列にロゴと版・状態、右の列にタブ・最小化・✕ と本文。ロゴの列とタブの行はどちらも
    // ドラッグ領域で、最小化と ✕ は右上端に置く。
    const brand = this.buildBrand();
    this.panel.appendChild(brand);
    const main = document.createElement('div');
    main.className = 'pm-main';
    this.panel.appendChild(main);
    const top = document.createElement('div');
    top.className = 'pm-top';
    main.appendChild(top);
    for (const dragArea of [brand, top]) {
      wireHeaderDrag(dragArea, {
        position: () => ({ x: this.panel.offsetLeft, y: this.panel.offsetTop }),
        moveTo: (x, y) => this.moveTo(x, y),
        onDragStart: () => { this.hasCustomPosition = true; },
      });
    }

    this.tabBar = new TabBar<PauseMenuTab>(TAB_LABELS, (tab) => this.setActiveTab(tab));
    this.tabBar.element.classList.add('pm-tabs', 'w-tabs--neutral');
    top.appendChild(this.tabBar.element);
    this.minimizeToggle = new Button('', () => this.setMinimized(!this.minimized), undefined, 'icon');
    top.appendChild(this.minimizeToggle.element);
    top.appendChild(new CloseButton(() => this.toggle(false)).element);

    this.body = document.createElement('div');
    this.body.className = 'pm-body';
    main.appendChild(this.body);

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
    this.bgmValue = document.createElement('span');
    this.bgmSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (vol) => {
      this.updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });
    this.bgmMute = new Button('', () => this.toggleMute(), SPEAKER_ICON_SVG, 'icon');
    this.bgmMute.element.title = '消音';
    this.bgmMute.element.setAttribute('aria-label', '消音');
    this.pauseTabPanel.appendChild(this.buildBgmRow());
    this.syncBgmVolume(bgmVolume);
    this.pauseTabPanel.appendChild(this.buildActionGrid());

    this.setActiveTab('pause');
    // ビューポート変化と内容サイズの変化のたびに現在位置を収め直す。
    onViewportChange(() => this.reclamp());
    this.resizeObserver = new ResizeObserver(() => this.reclamp());
    this.resizeObserver.observe(this.panel);
  }

  // 開いているかどうか。台帳への登録の有無が正本。
  private get isOpen(): boolean {
    return this.overlayManager.isOverlayOpen(OVERLAY_ID);
  }

  // ロゴ・版情報・時間停止中の状態を、操作から独立したブランド欄へまとめる。
  private buildBrand(): HTMLElement {
    // ロゴ(タイトル画面と同じロゴタイプ)の下へ、会社名・版・状態ピップを積む。
    const brand = document.createElement('div');
    brand.className = 'pm-brand';

    const logotype = document.createElement('div');
    logotype.className = 'title-logotype';
    logotype.innerHTML = TITLE_LOGOTYPE_HTML;

    const meta = document.createElement('div');
    meta.className = 'pm-brand-meta';
    const label = document.createElement('span');
    label.className = 'ui-data-context';
    label.textContent = 'CISLUNAR OPERATIONS';
    const version = document.createElement('span');
    version.className = 'pm-brand-version';
    version.textContent = `v${__APP_VERSION__}`;
    const pip = document.createElement('span');
    pip.className = 'pm-brand-pip ui-pip on';
    pip.textContent = '時間停止中';
    meta.append(label, version, pip);

    brand.append(logotype, meta);
    return brand;
  }

  // ラベル・音量スライダー・音量の値・消音ボタンを1行に並べる。
  private buildBgmRow(): HTMLElement {
    const bgmRow = document.createElement('div');
    bgmRow.className = 'pm-row pm-bgm';
    const bgmLabel = document.createElement('span');
    bgmLabel.className = 'ui-k';
    bgmLabel.textContent = 'BGM';
    this.bgmValue.className = 'pm-bgm-value ui-v';
    bgmRow.append(bgmLabel, this.bgmSlider.element, this.bgmValue, this.bgmMute.element);
    return bgmRow;
  }

  // ゲームへ戻る・セーブ・セーブデータ管理・デバッグ表示を2列のボタンへ、タイトルへ戻るを末尾の
  // 1行へ並べる。キー割り当てのあるものはキーキャップを添える。
  private buildActionGrid(): HTMLElement {
    const actionGrid = document.createElement('div');
    actionGrid.className = 'pm-actions';
    // 1つのボタンを組んでグリッドへ足す。
    const addButton = (
      label: string, onClick: () => void, key?: string, variant?: ButtonVariant, extraClass?: string,
    ): void => {
      const btn = new Button(label, onClick, undefined, variant, key);
      btn.element.classList.add('pm-menu-btn');
      if (extraClass !== undefined) btn.element.classList.add(extraClass);
      actionGrid.appendChild(btn.element);
    };
    addButton('ゲームに戻る', () => this.toggle(false), K.pauseMenu.label, 'primary');
    addButton('セーブ', () => this.onSave?.(), K.manualSave.label);
    addButton('セーブデータの管理', () => this.onOpenSaveBrowser?.(), K.openSaveBrowser.label);
    addButton('デバッグ', () => this.onOpenDebugInfoWindow?.(), K.toggleDebugInfoWindow.label);
    addButton('タイトル画面に戻る', () => this.onQuitToTitle?.(), undefined, 'caution', 'pm-quit');
    return actionGrid;
  }

  // 鳴っていれば消音を、無音なら復帰を求める。
  private toggleMute(): void {
    this.onBgmMutedChange?.(this.bgmSlider.getValue() > 0);
  }

  // 消音ボタンの点灯と音量の値の表示を音量から合わせる。
  private updateMuteState(vol: number): void {
    this.bgmMute.setOn(vol <= 0);
    this.bgmValue.textContent = `${Math.round(vol * 100)}%`;
  }

  // 最小化状態を切り替える。パネルを閉じて再び開くと展開状態から始まる。
  private setMinimized(minimized: boolean): void {
    this.minimized = minimized;
    this.panel.classList.toggle('minimized', minimized);
    this.body.classList.toggle('hidden', minimized);
    this.syncMinimizeToggle();
    this.reclamp();
  }

  // 外側タブを切り替え、設定ビューの試聴と入力ゲートも状態を同期させる。
  private setActiveTab(tab: PauseMenuTab): void {
    this.activeTab = tab;
    this.tabBar.setSelected(tab);
    this.pauseTabPanel.hidden = tab !== 'pause';
    this._settingsView.element.hidden = tab !== 'settings';
    this._settingsView.setActive(tab === 'settings');
    if (this.isOpen) this.overlayManager.reconfigure(OVERLAY_ID, this.overlaySpec());
    this.reclamp();
  }

  // ESC メニューのオーバーレイ宣言を返す。設定タブの間は背景入力も遮る。
  private overlaySpec(): SurfaceSpec {
    return {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: this.activeTab === 'settings', dimsBackground: false,
      pausesGame: true, exclusiveGroup: SYSTEM_MODAL_GROUP,
    };
  }

  // 最小化トグルボタンの記号・aria-expanded・title を現在の折りたたみ状態に合わせる。
  private syncMinimizeToggle(): void {
    const button = this.minimizeToggle.element;
    this.minimizeToggle.setLabel(this.minimized ? COLLAPSE_COLLAPSED_GLYPH : COLLAPSE_EXPANDED_GLYPH);
    button.setAttribute('aria-expanded', String(!this.minimized));
    button.title = this.minimized ? '展開する' : '最小化する';
    button.setAttribute('aria-label', button.title);
  }

  // target がパネル要素の内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // パネルを閉じる。
  public close(): void {
    this.toggle(false);
  }

  // ESC メニューを展開した状態で開き、設定タブを選ぶ。
  public openSettings(): void {
    this.toggle(true);
    this.setMinimized(false);
    this.setActiveTab('settings');
  }

  // パネルの開閉を切り替える。force を渡すと開閉状態を明示的に指定する。
  public toggle(force?: boolean): void {
    const show = force !== undefined ? force : !this.isOpen;
    if (show === this.isOpen) return;
    // 閉じる前にタブを戻し、設定タブの試聴と入力遮断を解いておく。
    if (!show) this.setActiveTab('pause');
    this.panel.style.display = show ? 'grid' : 'none';
    if (show) {
      // 開くたびに一時停止タブ・展開状態から始め、動かされていなければ中央へ置く。
      // 先に登録して要素を DOM へ置いてから、実寸を測って中央寄せする。
      this.overlayManager.open(OVERLAY_ID, this.panel, this, this.overlaySpec());
      this.setActiveTab('pause');
      this.setMinimized(false);
      if (!this.hasCustomPosition) this.centerPanel();
    } else {
      this.overlayManager.close(OVERLAY_ID);
    }
  }

  // 画面中央へ配置する。
  private centerPanel(): void {
    const rect = this.panel.getBoundingClientRect();
    this.moveTo((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
  }

  // 要求座標をビューポート内へクランプして配置する。
  private moveTo(clientX: number, clientY: number): void {
    placeOverlayAt(this.panel, { x: clientX, y: clientY });
  }

  // 現在位置をビューポート内へ収め直す。
  private reclamp(): void {
    if (!this.isOpen) return;
    this.moveTo(this.panel.offsetLeft, this.panel.offsetTop);
  }

  // 開いている間、設定ビューの表示を更新する。nowMs [ms] はフレームの実時刻。毎フレーム呼ぶ。
  public sync(nowMs: number): void {
    if (!this.isOpen) return;
    this._settingsView.sync(nowMs);
  }

  // 外部から音量または消音状態が変更されたときに、消音を反映した音量 vol でスライダーと消音ボタンの表示を
  // 再描画する。
  public syncBgmVolume(vol: number): void {
    this.bgmSlider.setValue(vol);
    this.updateMuteState(vol);
  }
}
