// DOM オーバーレイの HUD のシェル。トースト・ヒント・ヘルプの表示と、
// root/svgOverlay の公開・ステータスパネル同期(panels)を担う。
import { buildHudDom } from './dom';
import { HudPanels } from './panel';
import type { Input } from '../input/input';
import type { OverlayLayers } from './overlay-layer';
import type { OverlayManager } from './overlay-manager';
import type { HelpPanel } from './help-panel';

export class Hud {
  readonly root: HTMLElement;
  readonly layers: OverlayLayers;
  readonly svgOverlay: SVGSVGElement;
  readonly overlayManager: OverlayManager;
  readonly helpPanel: HelpPanel;
  readonly panels: HudPanels;
  private hintUntil = 0;
  private toastUntil = 0;

  // HUD の DOM を構築する。
  constructor() {
    const { root, layers, svgOverlay, overlayManager, helpPanel, els } = buildHudDom();
    this.root = root;
    this.layers = layers;
    this.svgOverlay = svgOverlay;
    this.overlayManager = overlayManager;
    this.helpPanel = helpPanel;
    this.panels = new HudPanels(els);
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
