// DOM オーバーレイの HUD のシェル。トースト・ヒント・ヘルプの表示と、
// root/svgOverlay の公開・常設パネル群の所有を担う。
import { buildHudDom } from './hud-root';
import type { HudWorldView } from './panel-shell';
import { VesselPanel } from './panels/vessel-panel';
import { OrbitPanel } from './orbit/orbit-panel';
import { TargetPanel } from './panels/target-panel';
import { EnemiesPanel } from './panels/enemies-panel';
import { BurnManagementPanel, type BurnManagementViewModel } from './panels/burn-management-panel';
import { SimulationStatusBar } from './panels/simulation-status-bar';
import { MapScaleBadge } from './panels/map-scale-badge';
import { OrbitAnalysisWindow } from './orbit/orbit-analysis-window';
import type { Input } from '../input/input';
import type { CelestialBody } from '../../physics/celestial-body';
import type { Game } from '../game';
import type { OverlayLayers } from './overlay-layer';
import { TEMP_WINDOW_GROUP, type OverlayManager } from './overlay-manager';
import type { HelpPanel } from './windows/help-panel';

// 軌道分析パネルを開く既定位置。ドラッグ可能ウィンドウなのでビューポート内へクランプされる。
const ANALYSIS_WINDOW_OPEN_X = 320;
const ANALYSIS_WINDOW_OPEN_Y = 100;

export class Hud {
  readonly root: HTMLElement;
  readonly layers: OverlayLayers;
  readonly combatRoot: HTMLElement;
  readonly mapRoot: HTMLElement;
  readonly svgOverlay: SVGSVGElement;
  readonly overlayManager: OverlayManager;
  readonly helpPanel: HelpPanel;
  readonly simulationStatusBar: SimulationStatusBar;
  readonly viewBadgeRow: HTMLElement;
  readonly mapScaleBadge: MapScaleBadge;
  readonly vesselPanel: VesselPanel;
  readonly orbitPanel: OrbitPanel;
  readonly targetPanel: TargetPanel;
  readonly enemiesPanel: EnemiesPanel;
  readonly burnManagementPanel: BurnManagementPanel;
  private orbitAnalysisWindow: OrbitAnalysisWindow | null = null;
  private hintUntil = 0;
  private toastUntil = 0;

  // HUD の DOM を構築する。
  constructor() {
    const {
      root, layers, combatRoot, mapRoot, svgOverlay, overlayManager, helpPanel, els,
    } = buildHudDom();
    this.root = root;
    this.layers = layers;
    this.combatRoot = combatRoot.element;
    this.mapRoot = mapRoot.element;
    this.svgOverlay = svgOverlay;
    this.overlayManager = overlayManager;
    this.helpPanel = helpPanel;
    this.simulationStatusBar = new SimulationStatusBar(els);
    this.viewBadgeRow = els.get('gs-viewrow')!;
    this.mapScaleBadge = new MapScaleBadge(els);
    this.vesselPanel = new VesselPanel(els);
    this.orbitPanel = new OrbitPanel(els);
    this.targetPanel = new TargetPanel(els);
    this.enemiesPanel = new EnemiesPanel(els);
    this.burnManagementPanel = new BurnManagementPanel(els);
    this.burnManagementPanel.sync(null);
    this.orbitPanel.setOpenAnalysisHandler(() => this.openOrbitAnalysis());
    this.setWorldView('combat');
  }

  // 軌道分析パネルを開く。既に開いていれば最前面へ持ち上げるだけで、2枚目は開かない。
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

  // 戦闘/マップ HUD コントローラの sync から呼ばれる。窓が無ければ何もしない。
  syncOrbitAnalysis(game: Game, celestialBodies: readonly CelestialBody[]): void {
    this.orbitAnalysisWindow?.sync(game, celestialBodies);
  }

  // 戦闘/マップ固有の HUD ルートを切り替える。表示状態は ViewManager が正本として通知する。
  setWorldView(view: HudWorldView): void {
    const map = view === 'map';
    this.helpPanel.setWorldView(view);
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
    // 既存のビュー別スタイルが残る間も、共有 HUD の状態を同期しておく。
    this.root.classList.toggle('map-mode', map);
    this.root.classList.toggle('map-ui-active', map);
  }

  // ゲーム側で整えた表示用スナップショットだけを受け取り、Player 依存を HUD に持ち込まない。
  syncBurnManagement(view: BurnManagementViewModel | null): void {
    this.burnManagementPanel.sync(view);
  }

  // ヒントテキストを durationMs だけ表示する。
  hint(text: string, durationMs = 1800): void {
    const e = document.getElementById('hud-hint');
    if (!e) return;
    e.textContent = text;
    e.style.opacity = '1';
    this.hintUntil = performance.now() + durationMs;
  }

  // トースト(HTML)を durationMs だけ表示する。
  toast(html: string, durationMs = 8000): void {
    const e = document.getElementById('hud-toast');
    if (!e) return;
    e.innerHTML = html;
    e.style.opacity = '1';
    this.toastUntil = performance.now() + durationMs;
  }

  // ヘルプ表示キーの押下エッジを受け取る。
  handleInput(input: Input): void {
    this.helpPanel.handleInput(input);
  }

  // 表示期限を過ぎたヒント・トーストをフェードアウトさせる。
  tick(): void {
    const now = performance.now();
    // ヒントの期限切れ
    const hint = document.getElementById('hud-hint');
    if (hint && this.hintUntil && now > this.hintUntil) {
      hint.style.opacity = '0';
      this.hintUntil = 0;
    }
    // トーストの期限切れ
    const toast = document.getElementById('hud-toast');
    if (toast && this.toastUntil && now > this.toastUntil) {
      toast.style.opacity = '0';
      this.toastUntil = 0;
    }
  }
}
