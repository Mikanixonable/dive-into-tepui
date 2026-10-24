// ゲーム画面の HUD のシェル。常設パネル群と描画先(root)を持ち、
// 毎フレーム渡された値へ同期して、トースト・ヘルプを出す。
import type { RenderStyle } from '../../render/render-style';
import { buildHudDom } from './hud-root';
import type { HudLayers } from './hud-layers';
import type { PanelCollapse } from './panel-shell';
import type { ViewMode } from '../view/view-mode';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { VesselPanel, type VesselPanelViewModel } from './panels/vessel-panel';
import { OrbitPanel, type OrbitPanelViewModel } from './orbit/orbit-panel';
import { TargetPanel, type TargetPanelViewModel } from './panels/target-panel';
import { EnemiesPanel, type EnemiesPanelViewModel } from './panels/enemies-panel';
import { WeaponStrip, type WeaponStripViewModel } from './panels/weapon-strip';
import { BurnManagementPanel, type BurnManagementViewModel } from './panels/burn-management-panel';
import { ShipConstructionPanel } from './panels/ship-construction-panel';
import { TopBar, type TopBarViewModel } from './panels/top-bar';
import { AlarmBand } from './alarm-band';
import { Guidance, type PlanHintStage } from './guidance';
import { MapScaleBadge } from './panels/map-scale-badge';
import { OrbitAnalysisWindow, type OrbitAnalysisSubject } from './orbit/orbit-analysis-window';
import type { AnalysisChartSource } from './orbit/orbit-analysis-tab';
import type { Vec3 } from '../../math/vec3';
import type { OverlayLayers } from '../../hud/overlay-layer';
import type { HudShell } from '../../hud/hud-shell';
import type { OverlayManager } from '../../hud/overlay-manager';
import type { HelpPanel } from './windows/help-panel';
import type { HintKind, Notifier } from '../../hud/notifier';
import { ConfirmationOverlay } from '../../hud/windows/confirmation-overlay';
import { HudToast } from './hud-toast';
import type { ActiveAlarm } from '../alarm/alarm-evaluator';
import { hudAttention, hudWorkspace } from './hud-workspace';
import { HudSheet } from './hud-sheet';
import { MiniInstruments } from './panels/mini-instruments';

// 軌道分析ウィンドウを開く既定位置 [px]。
const ANALYSIS_WINDOW_OPEN_X = 320;
const ANALYSIS_WINDOW_OPEN_Y = 100;

// ランがこのフレームに常設パネルへ差し出す値。
export interface HudPanelViewModels {
  readonly topBar: TopBarViewModel;
  readonly vessel: VesselPanelViewModel | null;
  readonly weapon: WeaponStripViewModel | null;
  readonly orbit: OrbitPanelViewModel | null;
  readonly target: TargetPanelViewModel | null;
  readonly enemies: EnemiesPanelViewModel | null;
  readonly burnManagement: BurnManagementViewModel | null;
  // 出ている警報。警告が先、同じ段では新しいものが先。
  readonly alarms: readonly ActiveAlarm[];
  // 軌道計画の案内チップの段。出さないなら null。
  readonly planningHint: PlanHintStage | null;
  // 出ている警報をすべて確認済みにする。
  acknowledgeAlarm(): void;
  // マップカメラの注視点の ECI 位置。
  readonly mapFocus: Vec3;
  readonly analysisSource: AnalysisChartSource;
  readonly analysisSubject: OrbitAnalysisSubject | null;
}

export class Hud implements HudLayers, Notifier {
  public get root(): HTMLElement { return this.shell.root; }
  public get layers(): OverlayLayers { return this.shell.layers; }
  public get overlayManager(): OverlayManager { return this.shell.overlayManager; }
  public readonly combatRoot: HTMLElement;
  public readonly mapRoot: HTMLElement;
  private readonly helpPanel: HelpPanel;
  private readonly topBar: TopBar;
  private readonly alarmBand: AlarmBand;
  private readonly guidance: Guidance;
  // 直近の syncPanels が受けた、警報の確認の口。キーと警報帯のボタンはフレームの外で押される。
  private acknowledgeAlarmOnRun: (() => void) | null = null;
  public readonly viewBadgeRow: HTMLElement;
  private readonly mapScaleBadge: MapScaleBadge;
  private readonly vesselPanel: VesselPanel;
  private readonly weaponStrip: WeaponStrip;
  private readonly orbitPanel: OrbitPanel;
  private readonly targetPanel: TargetPanel;
  private readonly enemiesPanel: EnemiesPanel;
  private readonly burnManagementPanel: BurnManagementPanel;
  public readonly shipConstructionPanel: ShipConstructionPanel;
  public readonly constructionConfirm: ConfirmationOverlay;
  private orbitAnalysisWindow: OrbitAnalysisWindow | null = null;
  // 直近に見た目を合わせたビュー。DOM を組み替える差分の鍵。
  private chromeView: ViewMode | null = null;
  // 建造は ViewMode と独立した一時 workspace。ユーザーのパネル折りたたみ設定は変更しない。
  private constructionMode = false;
  private readonly toastBox: HudToast;
  // スマホ横持ちでレールが取る、下から出る計器シート。
  private readonly sheet: HudSheet;
  private readonly miniInstruments: MiniInstruments;

  // 画面の器の上に、ゲームの HUD の DOM を組む。renderStyle は組み立て時の見せ方で、
  // panelCollapse は各パネルの折りたたみトグルの配線役。
  public constructor(
    private readonly shell: HudShell, public readonly panelCollapse: PanelCollapse, renderStyle: RenderStyle,
  ) {
    const { combatRoot, mapRoot, helpPanel, els } = buildHudDom(shell, panelCollapse, renderStyle);
    this.combatRoot = combatRoot.element;
    this.mapRoot = mapRoot.element;
    this.helpPanel = helpPanel;

    // 常設パネルを、data-id で引ける要素の一覧から組む。
    this.topBar = new TopBar(els, this.overlayManager);
    this.alarmBand = new AlarmBand(
      this.root.querySelector<HTMLElement>('#hud-alarm-band')!, () => this.acknowledgeAlarm(),
    );
    this.guidance = new Guidance(
      this.root.querySelector<HTMLElement>('#hud-briefing')!, this.root.querySelector<HTMLElement>('#hud-hint')!,
    );
    this.viewBadgeRow = els.get('gs-viewrow');
    this.mapScaleBadge = new MapScaleBadge(els);
    this.vesselPanel = new VesselPanel(els);
    this.weaponStrip = new WeaponStrip(els);
    this.orbitPanel = new OrbitPanel(els, () => this.openOrbitAnalysis());
    this.targetPanel = new TargetPanel(els);
    this.enemiesPanel = new EnemiesPanel(els);
    this.burnManagementPanel = new BurnManagementPanel(els);
    this.shipConstructionPanel = new ShipConstructionPanel(els);
    this.constructionConfirm = new ConfirmationOverlay(this.overlayManager);
    this.toastBox = new HudToast(this.root);
    this.sheet = new HudSheet(this.overlayManager, this.root);
    this.miniInstruments = new MiniInstruments(els);

    // ランがまだ無い状態の見た目で組み上げる。
    this.burnManagementPanel.sync(null);
    this.applyView('combat');
    this.applyHudProfile('combat', false);
  }

  // 計器シートを開閉する。レールの無い幅(スマホ横持ち)で仮想パッドの取っ手が呼ぶ。
  public toggleSheet(): void {
    this.sheet.toggle();
  }

  // 軌道分析ウィンドウを開く。既に開いていれば、その1枚を最前面へ持ち上げる。
  private openOrbitAnalysis(): void {
    if (this.orbitAnalysisWindow) {
      this.orbitAnalysisWindow.bringToFront();
      return;
    }
    const win = new OrbitAnalysisWindow(
      ANALYSIS_WINDOW_OPEN_X, ANALYSIS_WINDOW_OPEN_Y, this.overlayManager,
    );
    win.onClose = () => { this.orbitAnalysisWindow = null; };
    this.orbitAnalysisWindow = win;
  }

  // HUD の見た目を、始まったランのステージ stageId に合わせる。creative ステージでは、マップにも
  // 艦の状態パネルを出す。
  public beginRun(stageId: string): void {
    this.root.classList.toggle('creative-mode', stageId === 'creative');
  }

  // 建造モード中の HUD 表示ゲートを切り替える。ViewMode や折りたたみ保存値は書き換えない。
  public setConstructionMode(active: boolean): void {
    if (this.constructionMode === active) return;
    this.constructionMode = active;
    if (active) this.sheet.close();
    this.root.classList.toggle('construction-mode', active);
    document.body.classList.toggle('hud-construction-mode', active);
    this.applyHudProfile(this.chromeView ?? 'combat', false);
  }

  // ランが畳まれたときに、ランの見た目とパネルが掴んでいるランの値・操作の口を落とす。
  public clearRunPanels(): void {
    this.root.classList.remove('creative-mode');
    this.root.classList.remove('construction-mode');
    document.body.classList.remove('hud-construction-mode');
    this.constructionMode = false;
    this.sheet.close();
    this.applyHudProfile(this.chromeView ?? 'combat', false);
    this.topBar.sync(null, 0);
    this.alarmBand.sync([]);
    this.guidance.foldBriefing();
    this.acknowledgeAlarmOnRun = null;
    this.vesselPanel.sync(null, 0);
    this.weaponStrip.sync(null, 0);
    this.orbitPanel.sync(null, 0);
    this.miniInstruments.sync(null, null, 0);
    this.targetPanel.sync(null, 0);
    this.enemiesPanel.sync(null, 0);
    this.burnManagementPanel.sync(null);
  }

  // view で表に出ている常設パネルと、控えられたトーストを panels の値へ合わせる。
  // camera はこのフレームの表示カメラで、縮尺表示が読む。nowMs はフレームの実時刻 [ms]。
  public syncPanels(
    view: ViewMode, panels: HudPanelViewModels, camera: CameraFrame, nowMs: number,
  ): void {
    const map = view === 'map';
    this.panelCollapse.sync(view);
    this.applyView(view);
    this.applyHudProfile(view, panels.target !== null);
    this.sheet.sync(view, panels.target !== null);
    // 両ビュー共通のパネル。
    this.burnManagementPanel.sync(panels.burnManagement);
    this.topBar.sync(panels.topBar, nowMs);
    this.acknowledgeAlarmOnRun = () => panels.acknowledgeAlarm();
    this.alarmBand.sync(panels.alarms);
    this.guidance.sync(panels.planningHint, panels.alarms.length > 0, nowMs);
    this.orbitPanel.sync(panels.orbit, nowMs);
    this.miniInstruments.sync(panels.orbit, map ? null : panels.vessel, nowMs);
    // ビュー固有のパネル。
    if (map) {
      this.mapScaleBadge.sync(camera.scale, panels.mapFocus);
    } else {
      this.vesselPanel.sync(panels.vessel, nowMs);
      this.weaponStrip.sync(panels.weapon, nowMs);
      this.targetPanel.sync(panels.target, nowMs);
      this.enemiesPanel.sync(panels.enemies, nowMs);
    }
    this.orbitAnalysisWindow?.sync(panels.analysisSource, panels.analysisSubject, nowMs);
    this.toastBox.sync(nowMs);
  }

  // workspace は画面の大分類、attention は flight 内の一時的な強調状態。DOM再配置ではなく
  // dataset と CSS で表現し、ターゲット取得時にもパネル位置を揺らさない。
  private applyHudProfile(view: ViewMode, hasCombatTarget: boolean): void {
    this.root.dataset['workspace'] = hudWorkspace(view, this.constructionMode);
    this.root.dataset['attention'] = hudAttention(view, this.constructionMode, hasCombatTarget);
  }

  // 表に出す HUD ルートと、両ビューで1つを使い回すパネルの置き場を view へ揃える。
  private applyView(view: ViewMode): void {
    if (this.chromeView === view) return;
    this.chromeView = view;
    const map = view === 'map';
    const orbit = this.root.querySelector<HTMLElement>('#hud-orbit');
    const burnManagement = this.root.querySelector<HTMLElement>('#burn-management-panel');
    const leftRail = (map ? this.mapRoot : this.combatRoot)
      .querySelector<HTMLElement>('.hud-rail-left');
    if (orbit && burnManagement && leftRail) {
      const viewOptions = map ? leftRail.querySelector<HTMLElement>('#hud-view-options') : null;
      // Orbit → Burn management → View Options の順で、単一の DOM をビュー間で移動する。
      if (map) {
        leftRail.insertBefore(orbit, viewOptions ?? leftRail.firstChild);
        leftRail.insertBefore(burnManagement, orbit.nextSibling);
      } else {
        leftRail.appendChild(orbit);
        leftRail.appendChild(burnManagement);
      }
    }
    this.combatRoot.classList.toggle('active', !map);
    this.mapRoot.classList.toggle('active', map);
    this.root.classList.toggle('map-ui-active', map);
  }

  // 設定の正本から通知された見せ方を HUD の DOM へ反映する。設定へは書き戻さない。
  public syncRenderStyle(style: RenderStyle): void {
    this.root.dataset['renderStyle'] = style;
  }

  // 出ている警報をすべて確認済みにする。警報帯のボタンとキーの共通の入口。
  public acknowledgeAlarm(): void {
    this.acknowledgeAlarmOnRun?.();
  }

  // ステージ開始のブリーフィング(HTML)を、画面中央上部のカードに出す。
  public showBriefing(html: string): void {
    this.guidance.showBriefing(html);
  }

  // ブリーフィングのカードを畳む。最初の操作が起きたときに呼ぶ。
  public foldBriefing(): void {
    this.guidance.foldBriefing();
  }

  // 本文だけの通知を durationMs 表示する。kind は通知の意味上の種別。
  public hint(text: string, durationMs?: number, kind?: HintKind): void {
    this.toastBox.hint(text, durationMs, kind);
  }

  // HTML の通知を durationMs 表示する。
  public toast(html: string, durationMs?: number): void {
    this.toastBox.toast(html, durationMs);
  }

  // router から HUD 固有の単発入力を受け取る。
  public handleCommand(commandId: string): void {
    this.helpPanel.handleCommand(commandId);
  }
}
