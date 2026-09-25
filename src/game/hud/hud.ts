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
import {
  BurnManagementPanel,
  type BurnManagementPanelHandlers, type BurnManagementViewModel,
} from './panels/burn-management-panel';
import { ShipConstructionPanel } from './panels/ship-construction-panel';
import { TopBar, type TopBarViewModel } from './panels/top-bar';
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
import { hudAttention, hudWorkspace } from './hud-workspace';

// 軌道分析ウィンドウを開く既定位置 [px]。
const ANALYSIS_WINDOW_OPEN_X = 320;
const ANALYSIS_WINDOW_OPEN_Y = 100;

// ランがこのフレームに常設パネルへ差し出す値。
export interface HudPanelViewModels {
  readonly topBar: TopBarViewModel;
  readonly vessel: VesselPanelViewModel | null;
  readonly orbit: OrbitPanelViewModel | null;
  readonly target: TargetPanelViewModel | null;
  readonly enemies: EnemiesPanelViewModel | null;
  readonly burnManagement: BurnManagementViewModel | null;
  readonly burnHandlers: BurnManagementPanelHandlers;
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
  public readonly viewBadgeRow: HTMLElement;
  private readonly mapScaleBadge: MapScaleBadge;
  private readonly vesselPanel: VesselPanel;
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
  // 次の tick() で表示するトースト。
  private pendingToast: {
    readonly content: string; readonly durationMs: number; readonly code: string; readonly warning: boolean;
    readonly allowHtml: boolean;
  } | null = null;
  // 表示中のトーストの期限 [ms, フレームの実時刻と同じ基準]。
  private toastUntil: number | null = null;

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
    this.topBar = new TopBar(els);
    this.viewBadgeRow = els.get('gs-viewrow')!;
    this.mapScaleBadge = new MapScaleBadge(els);
    this.vesselPanel = new VesselPanel(els);
    this.orbitPanel = new OrbitPanel(els, () => this.openOrbitAnalysis());
    this.targetPanel = new TargetPanel(els);
    this.enemiesPanel = new EnemiesPanel(els);
    this.burnManagementPanel = new BurnManagementPanel(els);
    this.shipConstructionPanel = new ShipConstructionPanel(els);
    this.constructionConfirm = new ConfirmationOverlay(this.layers.window, this.overlayManager);

    // ランがまだ無い状態の見た目で組み上げる。
    this.burnManagementPanel.sync(null, {});
    this.applyView('combat');
    this.applyHudProfile('combat', false);
  }

  // 軌道分析ウィンドウを開く。既に開いていれば、その1枚を最前面へ持ち上げる。
  private openOrbitAnalysis(): void {
    if (this.orbitAnalysisWindow) {
      this.orbitAnalysisWindow.bringToFront();
      return;
    }
    const win = new OrbitAnalysisWindow(
      this.layers.window, ANALYSIS_WINDOW_OPEN_X, ANALYSIS_WINDOW_OPEN_Y, this.overlayManager,
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
    this.applyHudProfile(this.chromeView ?? 'combat', false);
    this.topBar.sync(null, 0);
    this.vesselPanel.sync(null, 0);
    this.orbitPanel.sync(null, 0);
    this.targetPanel.sync(null, 0);
    this.enemiesPanel.sync(null, 0);
    this.burnManagementPanel.sync(null, {});
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
    // 両ビュー共通のパネル。
    this.burnManagementPanel.sync(panels.burnManagement, panels.burnHandlers);
    this.topBar.sync(panels.topBar, nowMs);
    this.orbitPanel.sync(panels.orbit, nowMs);
    // ビュー固有のパネル。
    if (map) {
      this.mapScaleBadge.sync(camera.scale, panels.mapFocus);
    } else {
      this.vesselPanel.sync(panels.vessel, nowMs);
      this.targetPanel.sync(panels.target, nowMs);
      this.enemiesPanel.sync(panels.enemies, nowMs);
    }
    this.orbitAnalysisWindow?.sync(panels.analysisSource, panels.analysisSubject, nowMs);
    this.tick(nowMs);
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

  // 本文だけのトーストを durationMs 表示する。kind は通知の意味上の種別で、
  // バッジの記号と警告色をここで導く — 表示側が本文の文言から類推しない。
  public hint(text: string, durationMs = 1800, kind: HintKind = 'info'): void {
    const code = kind === 'warn' ? 'WARN' : kind === 'nav' ? 'NAV' : kind === 'plan' ? 'PLN' : 'SYS';
    this.requestToast(text, durationMs, code, kind === 'warn', false);
  }

  // 見出しと本文を持つ HTML のトーストを durationMs 表示する。
  public toast(html: string, durationMs = 8000): void {
    this.requestToast(html, durationMs, 'SYS', false, true);
  }

  // 表示したい文言と表示時間を控える。同じフレームに複数控えられたら最後のものが表示される。
  private requestToast(
    content: string, durationMs: number, code: string, warning: boolean, allowHtml: boolean,
  ): void {
    this.pendingToast = { content, durationMs, code, warning, allowHtml };
  }

  // router から HUD 固有の単発入力を受け取る。
  public handleCommand(commandId: string): void {
    this.helpPanel.handleCommand(commandId);
  }

  // 控えられたトーストを表示し、nowMs が表示期限を過ぎたトーストをフェードアウトさせる。
  private tick(nowMs: number): void {
    const toast = document.getElementById('hud-toast');
    if (!toast) return;
    // 控えがあれば差し替えて期限を張り直し、無ければ期限切れのものを消す。
    if (this.pendingToast) {
      const code = document.createElement('span');
      code.className = 'toast-code';
      code.textContent = this.pendingToast.code;
      const message = document.createElement('div');
      message.className = 'toast-message';
      if (this.pendingToast.allowHtml) message.innerHTML = this.pendingToast.content;
      else message.textContent = this.pendingToast.content;
      toast.replaceChildren(code, message);
      toast.classList.toggle('warn', this.pendingToast.warning);
      toast.style.opacity = '1';
      this.toastUntil = nowMs + this.pendingToast.durationMs;
      this.pendingToast = null;
    } else if (this.toastUntil !== null && nowMs > this.toastUntil) {
      toast.style.opacity = '0';
      this.toastUntil = null;
    }
  }
}
