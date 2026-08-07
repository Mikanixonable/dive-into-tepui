import { hudDock } from './hud/dom';
import { MapPickable } from './map-pick';

// マップ右クリックメニューから開く軌道オブジェクト一覧ウィンドウ。行クリックで onSelect に id を渡す。
export class ObjectListPanel {
  onSelect: ((id: string) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-object-list';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '軌道オブジェクト';
    this.panel.appendChild(title);
    this.body = document.createElement('div');
    this.panel.appendChild(this.body);
    hudDock(root, 'right').appendChild(this.panel);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  sync(items: readonly MapPickable[], focusId: string): void {
    this.body.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '対象なし';
      this.body.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'erow' + (item.id === focusId ? ' tgt' : '');
      row.textContent = item.name;
      row.addEventListener('click', () => this.onSelect?.(item.id));
      this.body.appendChild(row);
    }
  }
}
