// 図案タイル列。毎フレーム sync されても選択肢の中身が同じなら DOM を再構築せず、
// 選択中クラス(.on)と aria-pressed だけを更新する(ホバー・キーボードフォーカスを壊さないため)。
import { expandHitTarget } from '../../../hud/widgets/widget-base';

export interface TileItem<V> {
  readonly key: string;
  readonly value: V;
  readonly label: string;
  readonly title?: string;
  readonly glyphSvg?: string;
}

export class TileStrip<V> {
  public readonly element: HTMLElement;
  private items: readonly TileItem<V>[] = [];
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private selectedKey: string | null = null;

  public constructor(
    className: string,
    ariaLabel: string,
    private readonly onSelect: (value: V) => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = className;
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', ariaLabel);
  }

  // 選択肢を更新する。キー・ラベル・図案が前回と同一なら DOM を触らない。
  public setItems(next: readonly TileItem<V>[]): void {
    if (this.sameItems(next)) return;
    this.items = next;
    this.buttons.clear();
    this.element.replaceChildren();
    for (const item of next) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fc-tile';
      expandHitTarget(btn);
      btn.title = item.title ?? item.label;
      btn.setAttribute('aria-pressed', 'false');
      if (item.glyphSvg !== undefined) {
        const icon = document.createElement('span');
        icon.className = 'fc-tile-icon';
        icon.innerHTML = item.glyphSvg;
        btn.appendChild(icon);
      }
      const label = document.createElement('span');
      label.className = 'fc-tile-label';
      label.textContent = item.label;
      btn.appendChild(label);
      btn.addEventListener('click', (e) => {
        if (e.isTrusted) btn.blur();
        this.onSelect(item.value);
      });
      this.buttons.set(item.key, btn);
      this.element.appendChild(btn);
    }
    this.applySelected();
  }

  // 選択中のキーを反映する。
  public setSelectedKey(key: string | null): void {
    if (this.selectedKey === key && this.buttons.size > 0) return;
    this.selectedKey = key;
    this.applySelected();
  }

  private applySelected(): void {
    for (const [key, btn] of this.buttons) {
      const on = key === this.selectedKey;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  private sameItems(next: readonly TileItem<V>[]): boolean {
    if (next.length !== this.items.length) return false;
    return next.every((item, i) => {
      const prev = this.items[i]!;
      return item.key === prev.key && item.label === prev.label && item.glyphSvg === prev.glyphSvg;
    });
  }
}
