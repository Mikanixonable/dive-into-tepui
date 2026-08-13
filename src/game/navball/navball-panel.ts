// 表示設定ウィンドウの DOM: 天球グリッド(render/celestial-grid.ts)の2カテゴリーと
// 各カテゴリー内の3トグルを提供する。
import { Button } from '../hud/widgets';
import { CelestialGridVisibility } from '../../render/celestial-grid';

export type GridToggleGroup = {
  readonly categoryKey: keyof CelestialGridVisibility;
  readonly label: string;
  readonly items: readonly (readonly [keyof CelestialGridVisibility, string, string])[];
};

export class NavballPanel {
  onGridToggle: ((key: keyof CelestialGridVisibility, on: boolean) => void) | null = null;
  private readonly gridButtons: readonly (readonly [keyof CelestialGridVisibility, Button])[];
  private readonly categoryButtons: readonly (readonly [keyof CelestialGridVisibility, Button, HTMLElement, readonly Button[]])[];
  // 各トグルの現在値の鏡映し。正本は setGridVisibility が毎フレーム受け取る値側にあり、
  // ここはクリック時に反転元として読むためだけに保つ。
  private readonly current = new Map<keyof CelestialGridVisibility, boolean>();

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

    const gridButtons: (readonly [keyof CelestialGridVisibility, Button])[] = [];
    const categoryButtons: (readonly [keyof CelestialGridVisibility, Button, HTMLElement, readonly Button[]])[] = [];
    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'body-class-row grid-class-row';
      const category = this.toggleButton(group.label, `${group.label}を表示`, group.categoryKey);
      category.element.classList.add('body-class-title');
      row.appendChild(category.element);

      const buttonsEl = document.createElement('div');
      buttonsEl.className = 'body-class-btns';
      row.appendChild(buttonsEl);
      const individualButtons: Button[] = [];
      for (const [key, glyph, title] of group.items) {
        const button = this.toggleButton(glyph, title, key);
        button.element.classList.add('body-class-icon-btn');
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

  // クリックのたびに点灯を反転する小型トグルボタンを組む。description はホバー説明とタッチ向け
  // aria-label の両方に使う。
  private toggleButton(glyph: string, description: string, key: keyof CelestialGridVisibility): Button {
    const btn = new Button(glyph, () => {
      const next = !(this.current.get(key) ?? false);
      this.current.set(key, next);
      btn.setOn(next);
      this.onGridToggle?.(key, next);
    });
    btn.element.title = description;
    btn.element.setAttribute('aria-label', description);
    return btn;
  }

  setGridVisibility(visibility: CelestialGridVisibility): void {
    for (const [key, button] of this.gridButtons) {
      const on = visibility[key];
      this.current.set(key, on);
      button.setOn(on);
    }
    for (const [key, category, row, buttons] of this.categoryButtons) {
      const enabled = Boolean(visibility[key]);
      this.current.set(key, enabled);
      category.setOn(enabled);
      row.classList.toggle('category-off', !enabled);
      for (const button of buttons) button.setEnabled(enabled);
    }
  }
}
