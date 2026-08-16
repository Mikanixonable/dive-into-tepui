// DOM オーバーレイの HUD のシェル。トースト・ヒント・ヘルプの表示と、
// root/svgOverlay の公開・常設パネル群の所有を担う。
import { buildHudDom } from './hud-root';
import type { HudWorldView } from './panel-shell';
import { VesselPanel } from './vessel-panel';
import { OrbitPanel } from './orbit-panel';
import { TargetPanel } from './target-panel';
import { ContactsPanel } from './contacts-panel';
import { GlobalStatusBar } from './global-status-bar';
import { MapScaleBadge } from './map-scale-badge';
import type { Input } from '../input/input';
import type { OverlayLayers } from './overlay-layer';
import type { OverlayManager } from './overlay-manager';
import type { HelpPanel } from './help-panel';

export class Hud {
  readonly root: HTMLElement;
  readonly layers: OverlayLayers;
  readonly combatRoot: HTMLElement;
  readonly mapRoot: HTMLElement;
  readonly svgOverlay: SVGSVGElement;
  readonly overlayManager: OverlayManager;
  readonly helpPanel: HelpPanel;
  readonly globalStatusBar: GlobalStatusBar;
  readonly mapScaleBadge: MapScaleBadge;
  readonly vesselPanel: VesselPanel;
  readonly orbitPanel: OrbitPanel;
  readonly targetPanel: TargetPanel;
  readonly contactsPanel: ContactsPanel;
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
    this.globalStatusBar = new GlobalStatusBar(els);
    this.mapScaleBadge = new MapScaleBadge(els);
    this.vesselPanel = new VesselPanel(els);
    this.orbitPanel = new OrbitPanel(els);
    this.targetPanel = new TargetPanel(els);
    this.contactsPanel = new ContactsPanel(els);
    this.setWorldView('combat');
  }

  // 戦闘/マップ固有の HUD ルートを切り替える。表示状態は ViewManager が正本として通知する。
  setWorldView(view: HudWorldView): void {
    const map = view === 'map';
    this.combatRoot.classList.toggle('active', !map);
    this.mapRoot.classList.toggle('active', map);
    // 既存のビュー別スタイルが残る間も、共有 HUD の状態を同期しておく。
    this.root.classList.toggle('map-mode', map);
    this.root.classList.toggle('map-ui-active', map);
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
