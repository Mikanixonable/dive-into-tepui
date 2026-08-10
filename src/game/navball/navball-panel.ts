// 表示設定ウィンドウの DOM: 天球グリッド(render/celestial-grid.ts)の2カテゴリーと
// 各カテゴリー内の3トグルを提供する。
import { HudToggleButton, IconToggleButton } from '../hud/buttons';
import { CelestialGridVisibility } from '../../render/celestial-grid';

export type GridToggleGroup = {
  readonly categoryKey: keyof CelestialGridVisibility;
  readonly label: string;
  readonly items: readonly (readonly [keyof CelestialGridVisibility, string, string])[];
};

export class NavballPanel {
  onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;
  private readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, IconToggleButton])[];
  private readonly categoryButtons: readonly (readonly [keyof CelestialGridVisibility, HudToggleButton, HTMLElement, readonly IconToggleButton[]])[];

  constructor(root: HTMLElement, groups: readonly GridToggleGroup[]) {
    // MAP側の表示パネルが先に作られている場合は、天球グリッドの項目だけを
    // そこへ追加する。表示設定を二つのウィンドウへ分散させない。
    const existing = root.querySelector<HTMLElement>('#hud-overview-camera');
    const panel = existing ?? document.createElement('div');
    if (!existing) {
      panel.id = 'navball';
      panel.className = 'panel';
      panel.addEventListener('pointerdown', (e) => e.stopPropagation());
      const title = document.createElement('h3');
      title.textContent = '表示';
      panel.appendChild(title);
    }

    const gridButtons: (readonly [keyof CelestialGridVisibility, IconToggleButton])[] = [];
    const categoryButtons: (readonly [keyof CelestialGridVisibility, HudToggleButton, HTMLElement, readonly IconToggleButton[]])[] = [];
    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'body-class-row grid-class-row';
      const category = new HudToggleButton(group.label, `${group.label}を表示`, (on) => this.onGridToggle?.(group.categoryKey, on));
      category.element.classList.add('body-class-title');
      row.appendChild(category.element);

      const buttonsEl = document.createElement('div');
      buttonsEl.className = 'body-class-btns';
      row.appendChild(buttonsEl);
      const individualButtons: IconToggleButton[] = [];
      for (const [key, glyph, title] of group.items) {
        const button = new IconToggleButton(glyph, title, (on) => this.onGridToggle?.(key, on));
        button.setOn(false);
        buttonsEl.appendChild(button.element);
        gridButtons.push([key, button]);
        individualButtons.push(button);
      }
      panel.appendChild(row);
      categoryButtons.push([group.categoryKey, category, row, individualButtons]);
    }
    this.gridButtons = gridButtons;
    this.categoryButtons = categoryButtons;

    if (!existing) root.appendChild(panel);
  }

  setGridVisibility(visibility: CelestialGridVisibility): void {
    for (const [key, button] of this.gridButtons) button.setOn(visibility[key]);
    for (const [key, category, row, buttons] of this.categoryButtons) {
      const enabled = Boolean(visibility[key]);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
      for (const button of buttons) button.setEnabled(enabled);
    }
  }
}
