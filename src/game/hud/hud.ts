// DOM オーバーレイの HUD のシェル。トースト・ヘルプの表示と、
// root/svgOverlay の公開・常設パネル群の所有を担う。
import type { RenderStyleSetting } from '../../render/render-style';
import { buildHudDom } from './hud-root';
import type { HudWorldView } from './panel-shell';
import { VesselPanel } from './panels/vessel-panel';
import { OrbitPanel } from './orbit/orbit-panel';
import { TargetPanel } from './panels/target-panel';
import { EnemiesPanel } from './panels/enemies-panel';
import { BurnManagementPanel, type BurnManagementViewModel } from './panels/burn-management-panel';
import { TopBar } from './panels/top-bar';
import { MapScaleBadge } from './panels/map-scale-badge';
import { OrbitAnalysisWindow } from './orbit/orbit-analysis-window';
import type { Input } from '../input/input';
import { CelestialMotion } from '../../physics/celestial-motion';
import type { Game } from '../game';
import type { OverlayLayers } from './overlay-layer';
import { TEMP_WINDOW_GROUP, type OverlayManager } from './overlay-manager';
import type { HelpPanel } from './windows/help-panel';

// 軌道分析パネルを開く既定位置。ドラッグ可能ウィンドウなのでビューポート内へクランプされる。
const ANALYSIS_WINDOW_OPEN_X = 320;
const ANALYSIS_WINDOW_OPEN_Y = 100;

export class Hud {
  public readonly root: HTMLElement;
  public readonly layers: OverlayLayers;
  public readonly combatRoot: HTMLElement;
  public readonly mapRoot: HTMLElement;
  public readonly svgOverlay: SVGSVGElement;
  public readonly overlayManager: OverlayManager;
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
  private toastUntil = 0;

  // HUD の DOM を構築する。
  public constructor(public readonly renderStyle: RenderStyleSetting) {
    const {
      root, layers, combatRoot, mapRoot, svgOverlay, overlayManager, helpPanel, els,
    } = buildHudDom(renderStyle);
    // 構築済みの DOM 参照を受け取る。
    this.root = root;
    this.layers = layers;
    this.combatRoot = combatRoot.element;
    this.mapRoot = mapRoot.element;
    this.svgOverlay = svgOverlay;
    this.overlayManager = overlayManager;
    this.helpPanel = helpPanel;

    // data-id で引ける要素だけを各パネルへ渡し、DOM の組み立て方を持ち込ませない。
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
  public syncOrbitAnalysis(game: Game, celestialBodies: readonly CelestialMotion[]): void {
    this.orbitAnalysisWindow?.sync(game, celestialBodies);
  }

  // 戦闘/マップ固有の HUD ルートを切り替える。表示状態は ViewManager が正本として通知する。
  public setWorldView(view: HudWorldView): void {
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
  public syncBurnManagement(view: BurnManagementViewModel | null): void {
    this.burnManagementPanel.sync(view);
  }

  // 見出しを持たないメッセージのみ型トーストを durationMs だけ表示する。
  public hint(text: string, durationMs = 1800): void {
    this.showToast(text, durationMs);
  }

  // 見出し+本文を持つタイトル-説明型トースト(HTML)を durationMs だけ表示する。
  public toast(html: string, durationMs = 8000): void {
    this.showToast(html, durationMs);
  }

  // トースト DOM の内容と表示期限を差し替える(hint/toast 共通の下請け)。
  private showToast(html: string, durationMs: number): void {
    const e = document.getElementById('hud-toast');
    if (!e) return;
    e.innerHTML = html;
    e.style.opacity = '1';
    this.toastUntil = performance.now() + durationMs;
  }

  // ヘルプ表示キーの押下エッジを受け取る。
  public handleInput(input: Input): void {
    this.helpPanel.handleInput(input);
  }

  // 表示期限を過ぎたトーストをフェードアウトさせる。
  public tick(): void {
    const now = performance.now();
    const toast = document.getElementById('hud-toast');
    if (toast && this.toastUntil && now > this.toastUntil) {
      toast.style.opacity = '0';
      this.toastUntil = 0;
    }
  }
}
