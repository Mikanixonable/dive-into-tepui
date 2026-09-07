// ゲーム画面の HUD のシェル。常設パネル群と描画先(root / svgOverlay)を持ち、
// 毎フレーム game の状態へ同期して、トースト・ヘルプを出す。
import type { RenderStyleSetting } from '../../render/render-style';
import { buildHudDom } from './hud-root';
import type { View } from '../view/view';
import { VesselPanel } from './panels/vessel-panel';
import { OrbitPanel } from './orbit/orbit-panel';
import { TargetPanel } from './panels/target-panel';
import { EnemiesPanel } from './panels/enemies-panel';
import { BurnManagementPanel } from './panels/burn-management-panel';
import { TopBar } from './panels/top-bar';
import { MapScaleBadge } from './panels/map-scale-badge';
import { OrbitAnalysisWindow } from './orbit/orbit-analysis-window';
import type { Input } from '../../input/input';
import type { Game } from '../game';
import type { OverlayLayers } from '../../hud/overlay-layer';
import type { HudShell } from '../../hud/hud-shell';
import { TEMP_WINDOW_GROUP, type OverlayManager } from '../../hud/overlay-manager';
import type { HelpPanel } from './windows/help-panel';

// 軌道分析ウィンドウを開く既定位置 [px]。
const ANALYSIS_WINDOW_OPEN_X = 320;
const ANALYSIS_WINDOW_OPEN_Y = 100;

export class Hud {
  public get root(): HTMLElement { return this.shell.root; }
  public get layers(): OverlayLayers { return this.shell.layers; }
  public get overlayManager(): OverlayManager { return this.shell.overlayManager; }
  public readonly combatRoot: HTMLElement;
  public readonly mapRoot: HTMLElement;
  public readonly svgOverlay: SVGSVGElement;
  public readonly helpPanel: HelpPanel;
  public readonly topBar: TopBar;
  public readonly viewBadgeRow: HTMLElement;
  public readonly mapScaleBadge: MapScaleBadge;
  public readonly vesselPanel: VesselPanel;
  public readonly orbitPanel: OrbitPanel;
  public readonly targetPanel: TargetPanel;
  public readonly enemiesPanel: EnemiesPanel;
  public readonly burnManagementPanel: BurnManagementPanel;
  private orbitAnalysisWindow: OrbitAnalysisWindow | null = null;
  // 次の tick() で表示するトースト。
  private pendingToast: { readonly html: string; readonly durationMs: number } | null = null;
  // 表示中のトーストの期限 [ms, performance.now() 基準]。
  private toastUntil: number | null = null;

  // 画面の器の上に、ゲームの HUD の DOM を組む。
  public constructor(
    private readonly shell: HudShell, public readonly renderStyle: RenderStyleSetting,
  ) {
    const { combatRoot, mapRoot, svgOverlay, helpPanel, els } = buildHudDom(shell, renderStyle);
    this.combatRoot = combatRoot.element;
    this.mapRoot = mapRoot.element;
    this.svgOverlay = svgOverlay;
    this.helpPanel = helpPanel;

    // 常設パネルを、data-id で引ける要素の一覧から組む。
    this.topBar = new TopBar(els);
    this.viewBadgeRow = els.get('gs-viewrow')!;
    this.mapScaleBadge = new MapScaleBadge(els);
    this.vesselPanel = new VesselPanel(els);
    this.orbitPanel = new OrbitPanel(els);
    this.targetPanel = new TargetPanel(els);
    this.enemiesPanel = new EnemiesPanel(els);
    this.burnManagementPanel = new BurnManagementPanel(els);

    // 初期表示の配線。
    this.burnManagementPanel.sync(null);
    this.orbitPanel.setOpenAnalysisHandler(() => this.openOrbitAnalysis());
    this.setView('combat');
  }

  // 軌道分析ウィンドウを開く。既に開いていれば、その1枚を最前面へ持ち上げる。
  private openOrbitAnalysis(): void {
    if (this.orbitAnalysisWindow) {
      this.orbitAnalysisWindow.bringToFront();
      return;
    }
    const win = new OrbitAnalysisWindow(
      this.layers.window, ANALYSIS_WINDOW_OPEN_X, ANALYSIS_WINDOW_OPEN_Y, this.overlayManager, TEMP_WINDOW_GROUP,
    );
    win.onClose = () => { this.orbitAnalysisWindow = null; };
    this.orbitAnalysisWindow = win;
  }

  // 軌道分析ウィンドウが見ている個体を、このフレームの操作対象・ターゲットへ合わせる。
  public updateAnalysisReaders(game: Game): void {
    this.orbitAnalysisWindow?.update(game);
  }

  // view で表に出ている常設パネルを game の現在状態へ合わせる。
  public syncPanels(view: View, game: Game): void {
    const map = view === 'map';
    // 両ビュー共通のパネル。
    this.burnManagementPanel.sync(game.activeControllable?.boosters?.managementViewModel() ?? null);
    this.topBar.sync(game);
    this.orbitPanel.sync(game);
    // ビュー固有のパネル。
    if (map) {
      this.mapScaleBadge.sync(game);
    } else {
      this.vesselPanel.sync(game);
      this.targetPanel.sync(game);
      this.enemiesPanel.sync(game);
    }
    this.orbitAnalysisWindow?.sync(game);
    this.tick();
  }

  // 表に出す HUD ルートを戦闘/マップで切り替える。
  public setView(view: View): void {
    const map = view === 'map';
    this.helpPanel.setView(view);
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

  // 本文だけのトーストを durationMs 表示する。
  public hint(text: string, durationMs = 1800): void {
    this.requestToast(text, durationMs);
  }

  // 見出しと本文を持つ HTML のトーストを durationMs 表示する。
  public toast(html: string, durationMs = 8000): void {
    this.requestToast(html, durationMs);
  }

  // 表示したい文言と表示時間を控える。同じフレームに複数控えられたら最後のものが表示される。
  private requestToast(html: string, durationMs: number): void {
    this.pendingToast = { html, durationMs };
  }

  // ヘルプ表示キーの押下エッジを受け取る。
  public handleInput(input: Input): void {
    this.helpPanel.handleInput(input);
  }

  // 控えられたトーストを表示し、表示期限を過ぎたトーストをフェードアウトさせる。
  private tick(): void {
    const toast = document.getElementById('hud-toast');
    if (!toast) return;
    const now = performance.now();
    if (this.pendingToast) {
      toast.innerHTML = this.pendingToast.html;
      toast.style.opacity = '1';
      this.toastUntil = now + this.pendingToast.durationMs;
      this.pendingToast = null;
    } else if (this.toastUntil !== null && now > this.toastUntil) {
      toast.style.opacity = '0';
      this.toastUntil = null;
    }
  }
}
