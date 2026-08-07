// 表示設定ウィンドウの DOM: 基準モードの排他選択と、天球グリッド(render/celestial-grid.ts)
// 6トグルを提供する。
import { hudButton, HudToggle } from '../hud/buttons';
import { CelestialGridVisibility } from '../../render/celestial-grid';
import type { NavballMode } from './navball';

export class NavballPanel {
  onModeSelect: ((mode: NavballMode) => void) | null = null;
  onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;

  private readonly modeButtons = new Map<NavballMode, HTMLElement>();

  // modeItems/gridToggleItems の並び順どおりにボタン・トグルを組み、root へ追加する。
  constructor(
    root: HTMLElement,
    modeItems: readonly (readonly [NavballMode, string])[],
    gridToggleItems: readonly (readonly [keyof CelestialGridVisibility, string])[],
  ) {
    const panel = document.createElement('div');
    panel.id = 'navball';
    panel.className = 'panel';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('h3');
    title.textContent = '表示';
    panel.appendChild(title);

    const modeRow = document.createElement('div');
    modeRow.className = 'hud-seg';
    const modeTitle = document.createElement('span');
    modeTitle.className = 'seg-title';
    modeTitle.textContent = '基準';
    modeRow.appendChild(modeTitle);
    for (const [mode, label] of modeItems) {
      const btn = hudButton(label, () => this.onModeSelect?.(mode));
      modeRow.appendChild(btn);
      this.modeButtons.set(mode, btn);
    }
    panel.appendChild(modeRow);

    for (const [key, label] of gridToggleItems) {
      const toggle = new HudToggle(label, (on) => this.onGridToggle?.(key, on));
      panel.appendChild(toggle.element);
    }

    root.appendChild(panel);
  }

  // 選択中モードのボタンを点灯させる。
  setMode(mode: NavballMode): void {
    for (const [m, btn] of this.modeButtons) btn.classList.toggle('on', m === mode);
  }

  // ターゲット不在のあいだ、ターゲット基準の2ボタンをクリック不能にする。
  setTargetModeEnabled(enabled: boolean): void {
    for (const key of ['targetPro', 'targetRetro'] as const) {
      this.modeButtons.get(key)?.classList.toggle('disabled', !enabled);
    }
  }

}
