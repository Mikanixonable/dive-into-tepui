// DOM オーバーレイの HUD のシェル。トースト・ヒント・ヘルプの表示と、WebGPU キャンバスの上に
// 重ねる root/svgOverlay の公開・ステータスパネル同期(panels)の合成のみを担う。
// 設定(一時停止メニュー)・予測パネル・マップ視点パネル・計画パネル・終了画面は、それぞれ
// SettingsPanel / PredictSystem / CameraSystem / PlanEditor / result-screen.ts が自分で所有する。
// マーカー表示(MarkerManager)は SVG オーバーレイを使う実装詳細に過ぎず、今後変わり得る一方、
// 各所から多数のマーカーが参照される点は変わらないため、実体は Hud ではなく Game が持つ
// (game.ts の markerManager フィールド)。Hud は DOM 構築で得た root/svgOverlay を
// 公開するのみで、マーカーの内容には関与しない。
//
// 内部構成:
//   - hud/dom.ts  … 静的 DOM/スタイル構築
//   - hud/panel.ts … ステータスパネル同期(panels として公開)
import { buildHudDom } from './dom';
import { HudPanels } from './panel';

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

  toggleHelp(): void {
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
