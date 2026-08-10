// 表示設定ウィンドウの DOM: 天球グリッド(render/celestial-grid.ts)6トグルを提供する。
import { HudToggle } from '../hud/buttons';
import { CelestialGridVisibility } from '../../render/celestial-grid';

export class NavballPanel {
  onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;

  // gridToggleItems の並び順どおりにトグルを組み、root へ追加する。
  constructor(
    root: HTMLElement,
    gridToggleItems: readonly (readonly [keyof CelestialGridVisibility, string])[],
  ) {
    const panel = document.createElement('div');
    panel.id = 'navball';
    panel.className = 'panel';
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('h3');
    title.textContent = '表示';
    panel.appendChild(title);

    for (const [key, label] of gridToggleItems) {
      const toggle = new HudToggle(label, (on) => this.onGridToggle?.(key, on));
      panel.appendChild(toggle.element);
    }

    root.appendChild(panel);
  }
}
