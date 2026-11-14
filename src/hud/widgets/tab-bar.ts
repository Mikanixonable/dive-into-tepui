// タブ切替。SegmentedControl と同じ「値の排他選択」だが、パネルの表示面そのものを
// 切り替える用途向けに role="tab" を持つ。
import { Button } from './button';

export class TabBar<T> {
  public readonly element: HTMLElement;
  private readonly buttons = new Map<T, Button>();
  private items: readonly (readonly [T, string, string?, string?])[] = [];

  // items は [値, 表示ラベル, 任意のキーキャップ, 任意のアイコン] の並びで、その順にタブを並べる。
  public constructor(items: readonly (readonly [T, string, string?, string?])[], private readonly onSelect: (value: T) => void) {
    this.element = document.createElement('div');
    this.element.className = 'w-tabs';
    this.element.setAttribute('role', 'tablist');
    this.setItems(items);
  }

  // 選択中の値のタブを点灯させる。
  public setSelected(value: T): void {
    for (const [v, btn] of this.buttons) {
      const selected = v === value;
      btn.setOn(selected);
      btn.element.setAttribute('aria-selected', String(selected));
      // タブは排他ボタンの見た目を借りるが、ARIA上は aria-pressed ではなく
      // aria-selected で選択状態を表す。
      btn.element.removeAttribute('aria-pressed');
    }
  }

  // タブ列を items へ一括で差し替える。SegmentedControl と同じく、同じ内容なら作り直さない。
  public setItems(items: readonly (readonly [T, string, string?, string?])[]): void {
    // 同じ内容なら作り直さない — 差し替えると押下中のタブが消えてクリックが届かなくなる。
    const same = (item: readonly [T, string, string?, string?], i: number): boolean => {
      const cur = this.items[i];
      return cur !== undefined && item[0] === cur[0] && item[1] === cur[1] && item[2] === cur[2] && item[3] === cur[3];
    };
    if (items.length === this.items.length && items.every(same)) return;
    // 内容が変わったときだけ全タブを組み直す。
    for (const btn of this.buttons.values()) btn.element.remove();
    this.buttons.clear();
    for (const [value, label, keyLabel, icon] of items) {
      const btn = new Button(label, () => this.onSelect(value), icon, undefined, keyLabel);
      btn.element.setAttribute('role', 'tab');
      this.element.appendChild(btn.element);
      this.buttons.set(value, btn);
    }
    this.items = items.map(([value, label, keyLabel, icon]) => [value, label, keyLabel, icon] as const);
  }

  // 値に対応するタブボタンの要素。タブパネルとの aria-controls 関連付けなど、
  // ボタン要素へ直接属性を追加設定する際に用いる。
  public buttonFor(value: T): HTMLElement | null {
    return this.buttons.get(value)?.element ?? null;
  }
}
