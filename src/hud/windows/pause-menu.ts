import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { SPACE_4 } from '../../theme';
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
  Button, buildCollapseToggle, CloseButton, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH,
  Slider, syncCollapseToggle, TabBar, type CollapseToggleLabels,
} from '../widgets';
import { wireHeaderDrag } from '../window-drag';
import { SettingsView } from '../panels/settings-view';

type PauseMenuTab = 'pause' | 'settings';

// OverlayManager の台帳上の id。開いているかどうかは登録の有無が正本。
const OVERLAY_ID = 'pause-menu';

// ヘッダーの最小化トグルの表示。共有の開閉トグル(buildCollapseToggle)の文言。
const PAUSE_MENU_MINIMIZE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '最小化する',
  collapsedTitle: '展開する',
};

// ESCメニュー(#hud-pause-menu)。一時停止操作と詳細設定を外側タブで切り替え、ヘッダーのドラッグ移動と
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
  private readonly minimizeToggle: HTMLElement;
  private hasCustomPosition = false;
  private activeTab: PauseMenuTab = 'pause';

  public onQuitToTitle: (() => void) | null = null;
  public onBgmVolumeChange: ((vol: number) => void) | null = null;
  // 消音ボタンが押されたときに、要求された消音の有無を渡して呼ばれる。
  public onBgmMutedChange: ((muted: boolean) => void) | null = null;
  public onSave: (() => void) | null = null;
  public onOpenSaveBrowser: (() => void) | null = null;
  public onOpenDebugInfoWindow: (() => void) | null = null;

  private readonly overlayManager: OverlayManager;
  private readonly resizeObserver: ResizeObserver;
  private readonly bgmSlider: Slider;
  private readonly bgmMute: Button;

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
    this.panel.className = 'panel ui-surface-focus editorial-workspace';

    // 本文はヘッダーの最小化トグル(共有の開閉トグル)の畳み対象でもあるため、ヘッダーより先に作る。
    this.body = document.createElement('div');
    this.body.className = 'pm-body';

    // ヘッダー: ロゴ・見出し・最小化トグル・✕ ボタンと、ドラッグ移動の配線。
    const header = document.createElement('div');
    header.className = 'pm-header';
    const headerTop = document.createElement('div');
    headerTop.className = 'pm-header-top';
    headerTop.appendChild(this.buildBrand());
    const headerActions = document.createElement('div');
    headerActions.className = 'pm-header-actions';
    // 最小化トグルは共有の開閉トグル。畳み状態は本文の collapsed クラスが正本で、
    // 見た目(▾/▸・aria-expanded・title)の同期も共有側が行う。
    this.minimizeToggle = buildCollapseToggle(
      headerActions, 'hud-pause-minimize', 'pm-minimize', this.body,
      PAUSE_MENU_MINIMIZE_LABELS, [], (collapsed) => this.setMinimized(collapsed),
    );
    const closeBtn = new CloseButton(() => this.toggle(false));
    headerActions.appendChild(closeBtn.element);
    header.appendChild(headerTop);
    const heading = document.createElement('h3');
    heading.className = 'pm-system-heading';
    heading.innerHTML = '<span class="ui-section-code" aria-hidden="true">SYS</span><span>SYSTEM / PAUSE</span>';
    const subheading = document.createElement('div');
    subheading.className = 'pm-system-sub ui-data-context';
    subheading.textContent = 'APPLICATION STATE · SUSPENDED';
    header.append(heading, subheading);
    const dragSession = {
      position: () => ({ x: this.panel.offsetLeft, y: this.panel.offsetTop }),
      moveTo: (x: number, y: number) => this.moveTo(x, y),
      onDragStart: () => { this.hasCustomPosition = true; },
    };
    wireHeaderDrag(header, dragSession);
    // 収納した帯はボタンの行だけになる。ボタン以外の隙間を掴んで動かせるよう、同じ配線を張る。
    wireHeaderDrag(headerActions, dragSession);
    this.panel.appendChild(header);

    this.panel.appendChild(this.body);
    // 最小化トグルと閉じるボタンはパネル全体の右上端へ浮かせる(SPEC UI-DESIGN §8)。
    // 収納時はこの行だけが残る小さな帯になる。
    this.panel.appendChild(headerActions);

    this.tabBar = new TabBar<PauseMenuTab>(
      [['pause', 'PAUSE'], ['settings', 'SETTINGS']], (tab) => this.setActiveTab(tab),
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

    // 一時停止タブ: BGM 音量行と操作ボタンのグリッド。
    this.bgmSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (vol) => {
      this.updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });
    this.bgmMute = new Button('消音', () => this.toggleMute());
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

  // タイトルとバージョンを ESC メニュー上部へ積む。
  private buildBrand(): HTMLElement {
    // 共有ロゴと版情報を、操作ヘッダーから独立したブランド欄へまとめる。
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
    meta.append(label, version);

    brand.append(logotype, meta);
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

  // セーブ・セーブデータ管理・デバッグ表示の導線と、タイトルへ戻るボタンを1つのグリッドへ並べる。
  private buildActionGrid(): HTMLElement {
    const actionGrid = document.createElement('div');
    actionGrid.className = 'pm-actions';
    // 幅いっぱいのボタン1つだけを持つ行を足す。
    // SPEC UI-DESIGN §8: 項目に番号は振らず、キー割り当てのあるものはキーキャップで添える。
    // keyLabel は Button がラベルの隣へキーキャップとして付ける。
    const addButtonRow = (label: string, onClick: () => void, keyLabel?: string): void => {
      const row = document.createElement('div');
      row.className = 'pm-row';
      const btn = new Button(label, onClick, undefined, undefined, keyLabel);
      btn.element.classList.add('pm-menu-btn');
      btn.element.style.flex = '1';
      row.appendChild(btn.element);
      actionGrid.appendChild(row);
    };
    addButtonRow('ゲームに戻る', () => this.toggle(false));
    addButtonRow('セーブ', () => this.onSave?.());
    addButtonRow('セーブデータの管理', () => this.onOpenSaveBrowser?.());
    addButtonRow('デバッグ', () => this.onOpenDebugInfoWindow?.(), K.toggleDebugInfoWindow.label);

    const quitBtn = new Button('タイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('pm-menu-btn', 'pm-quit');
    actionGrid.appendChild(quitBtn.element);
    return actionGrid;
  }

  // 鳴っていれば消音を、無音なら復帰を求める。
  private toggleMute(): void {
    this.onBgmMutedChange?.(this.bgmSlider.getValue() > 0);
  }

  // 消音ボタンの点灯を音量から合わせる。
  private updateMuteState(vol: number): void {
    this.bgmMute.setOn(vol <= 0);
  }

  // 最小化状態を切り替える。パネルを閉じて再び開くと展開状態から始まる。
  // 畳み状態は本文の collapsed クラスが正本で、トグルの見た目は共有の同期へ委ねる。
  private setMinimized(minimized: boolean): void {
    this.panel.classList.toggle('minimized', minimized);
    this.body.classList.toggle('hidden', minimized);
    this.body.classList.toggle('collapsed', minimized);
    syncCollapseToggle(this.minimizeToggle, this.body, PAUSE_MENU_MINIMIZE_LABELS);
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
    this.panel.classList.toggle('open', show);
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
