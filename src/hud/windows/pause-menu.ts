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
  Button, buildCollapseToggle, CloseButton, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH,
  Slider, syncCollapseToggle, TabBar, type CollapseToggleLabels,
} from '../widgets';
import { wireHeaderDrag } from '../window-drag';
import { SettingsView } from '../panels/settings-view';

type PauseMenuTab = 'pause' | 'settings';

// 状態の帯に出す、止めたゲームの所在。タイトル画面から開いているときは無い(null)。
export interface PauseMenuSession {
  readonly stageLabel: string;
  // 経過時間 T+ の表示文字列。
  readonly elapsed: string;
}

// 状態の帯の要素と、書き換える値の欄。
interface StatusBand {
  readonly element: HTMLElement;
  readonly stage: HTMLElement;
  readonly elapsed: HTMLElement;
}

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
  private readonly statusBand: StatusBand;

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

    // ヘッダー: ロゴと外側タブを1行に並べ、全体をドラッグ領域にする。
    const header = document.createElement('div');
    header.className = 'pm-header';
    header.appendChild(this.buildBrand());
    this.tabBar = new TabBar<PauseMenuTab>(
      [['pause', '一時停止'], ['settings', '設定']],
      (tab) => this.setActiveTab(tab),
    );
    this.tabBar.element.classList.add('pm-tabs', 'ui-surface-inset');
    header.appendChild(this.tabBar.element);
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
    const dragSession = {
      position: () => ({ x: this.panel.offsetLeft, y: this.panel.offsetTop }),
      moveTo: (x: number, y: number) => this.moveTo(x, y),
      onDragStart: () => { this.hasCustomPosition = true; },
    };
    wireHeaderDrag(header, dragSession);
    // 収納した帯はボタンの行だけになる。ボタン以外の隙間を掴んで動かせるよう、同じ配線を張る。
    wireHeaderDrag(headerActions, dragSession);
    this.panel.appendChild(header);

    // 状態の帯: 止めたゲームの所在。ゲーム中だけ出す。
    this.statusBand = this.buildStatusBand();
    this.panel.appendChild(this.statusBand.element);

    this.panel.appendChild(this.body);
    // 最小化トグルと閉じるボタンはパネル全体の右上端へ浮かせる(SPEC UI-DESIGN §8)。
    // 収納時はこの行だけが残る小さな帯になる。
    this.panel.appendChild(headerActions);

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

    // 一時停止タブ: 操作のタイルと、BGM 音量・タイトルへ戻るの下段。
    this.bgmSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (vol) => {
      this.updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });
    this.bgmMute = new Button('消音', () => this.toggleMute());
    this.pauseTabPanel.appendChild(this.buildActionTiles());
    this.pauseTabPanel.appendChild(this.buildFooterRow());
    this.syncBgmVolume(bgmVolume);

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

  // ロゴとバージョンのブランド欄を組む。
  private buildBrand(): HTMLElement {
    const brand = document.createElement('div');
    brand.className = 'pm-brand';
    const logotype = document.createElement('div');
    logotype.className = 'title-logotype';
    logotype.innerHTML = TITLE_LOGOTYPE_HTML;
    const version = document.createElement('span');
    version.className = 'pm-brand-version';
    version.textContent = `v${__APP_VERSION__}`;
    brand.append(logotype, version);
    return brand;
  }

  // 状態の帯を組む。止まっていることの印と、ステージ名・経過時間の欄を持つ。
  private buildStatusBand(): StatusBand {
    const element = document.createElement('div');
    element.className = 'pm-status ui-surface-inset';
    element.hidden = true;
    const paused = document.createElement('span');
    paused.className = 'pm-status-paused';
    paused.innerHTML = '<span class="pm-status-pip" aria-hidden="true"></span>PAUSED';
    // 項目名と値の一組を帯へ足し、値の要素を返す。
    const addField = (label: string): HTMLElement => {
      const field = document.createElement('span');
      field.className = 'pm-status-field';
      const key = document.createElement('span');
      key.className = 'k';
      key.textContent = label;
      const value = document.createElement('span');
      value.className = 'v';
      field.append(key, value);
      element.appendChild(field);
      return value;
    };
    element.appendChild(paused);
    return { element, stage: addField('ステージ'), elapsed: addField('T+') };
  }

  // 一時停止の操作を、名前と何が起きるかの1行を持つタイルで並べる。主操作は「ゲームに戻る」だけ。
  private buildActionTiles(): HTMLElement {
    const tiles = document.createElement('div');
    tiles.className = 'pm-actions';
    // SPEC UI-DESIGN §8: 項目に番号は振らず、キー割り当てのあるものはキーキャップで添える。
    const addTile = (
      label: string, description: string, onClick: () => void, keyLabel?: string, primary = false,
    ): void => {
      const btn = new Button(label, onClick, undefined, primary ? 'primary' : undefined, keyLabel);
      btn.element.classList.add('pm-tile');
      const note = document.createElement('span');
      note.className = 'pm-tile-note';
      note.textContent = description;
      btn.element.appendChild(note);
      tiles.appendChild(btn.element);
    };
    addTile('ゲームに戻る', '止めた時点から再開する', () => this.toggle(false), K.pauseMenu.label, true);
    addTile('セーブ', 'いまの時点を記録する', () => this.onSave?.());
    addTile('セーブデータの管理', 'セーブ枠と記録した時点を選ぶ', () => this.onOpenSaveBrowser?.());
    addTile('負荷表示', '描画と計算の負荷を表示する', () => this.onOpenDebugInfoWindow?.(), K.toggleDebugInfoWindow.label);
    return tiles;
  }

  // BGM 音量の行と「タイトル画面に戻る」を並べた下段を組む。タイトルへ戻るは主操作から最も遠い右端に置く。
  private buildFooterRow(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'pm-footer';
    const bgmRow = document.createElement('div');
    bgmRow.className = 'pm-volume ui-surface-inset';
    const bgmLabel = document.createElement('span');
    bgmLabel.className = 'k';
    bgmLabel.textContent = 'BGM 音量';
    bgmRow.append(bgmLabel, this.bgmSlider.element, this.bgmMute.element);
    const quitBtn = new Button('タイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('pm-quit');
    footer.append(bgmRow, quitBtn.element);
    return footer;
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

  // 状態の帯を、止めたゲームの所在 session に合わせる。session が null(タイトル画面)なら帯を隠す。
  // 毎フレーム呼んでよく、開いていない間と値が変わらない間は DOM を書き換えない。
  public syncSession(session: PauseMenuSession | null): void {
    if (!this.isOpen) return;
    const band = this.statusBand;
    band.element.hidden = session === null;
    if (session === null) return;
    if (band.stage.textContent !== session.stageLabel) band.stage.textContent = session.stageLabel;
    if (band.elapsed.textContent !== session.elapsed) band.elapsed.textContent = session.elapsed;
  }

  // 外部から音量または消音状態が変更されたときに、消音を反映した音量 vol でスライダーと消音ボタンの表示を
  // 再描画する。
  public syncBgmVolume(vol: number): void {
    this.bgmSlider.setValue(vol);
    this.updateMuteState(vol);
  }
}
