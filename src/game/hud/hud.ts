// DOM オーバーレイの HUD のシェル。トースト・ヒント・ヘルプの表示と、
// root/svgOverlay の公開・ステータスパネル同期(panels)を担う。
import { buildHudDom } from './dom';
import { HudPanels } from './panel';
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';

export class Hud {
  readonly root: HTMLElement;
  readonly svgOverlay: SVGSVGElement;
  readonly panels: HudPanels;
  private hintUntil = 0;
  private toastUntil = 0;

  constructor() {
    const { root, svgOverlay, els } = buildHudDom();
    this.root = root;
    this.svgOverlay = svgOverlay;
    this.panels = new HudPanels(els);
  }

  hint(text: string, durationMs = 1800): void {
    const e = document.getElementById('hud-hint');
    if (!e) return;
    e.textContent = text;
    e.style.opacity = '1';
    this.hintUntil = performance.now() + durationMs;
  }

  toast(html: string, durationMs = 8000): void {
    const e = document.getElementById('hud-toast');
    if (!e) return;
    e.innerHTML = html;
    e.style.opacity = '1';
    this.toastUntil = performance.now() + durationMs;
  }

  handleInput(input: Input): void {
    if (input.takeKey(K.help)) this.toggleHelp();
  }

  private toggleHelp(): void {
    const e = document.getElementById('hud-help');
    if (e) e.style.display = e.style.display === 'block' ? 'none' : 'block';
  }

  tick(): void {
    const now = performance.now();
    const hint = document.getElementById('hud-hint');
    if (hint && this.hintUntil && now > this.hintUntil) {
      hint.style.opacity = '0';
      this.hintUntil = 0;
    }
    const toast = document.getElementById('hud-toast');
    if (toast && this.toastUntil && now > this.toastUntil) {
      toast.style.opacity = '0';
      this.toastUntil = 0;
    }
  }
}
