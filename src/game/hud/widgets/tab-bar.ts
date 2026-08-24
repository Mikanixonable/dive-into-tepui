// タブ切替。SegmentedControl と同じ「値の排他選択」だが、パネルの表示面そのものを
// 切り替える用途向けに role="tab" を持つ。
import { Button } from './button';

export class TabBar<T> {
  readonly element: HTMLElement;
  private readonly buttons = new Map<T, Button>();
  private items: readonly (readonly [T, string])[] = [];
  private readonly onSelect: (value: T) => void;

  // items は [値, 表示ラベル] の並びで、その順にタブを並べる。
  constructor(items: readonly (readonly [T, string])[], onSelect: (value: T) => void) {
    this.onSelect = onSelect;
    this.element = document.createElement('div');
    this.element.className = 'w-tabs';
    this.element.setAttribute('role', 'tablist');
    this.setItems(items);
  }

  // 選択中の値のタブを点灯させる。
  setSelected(value: T): void {
    for (const [v, btn] of this.buttons) {
      const selected = v === value;
      btn.setOn(selected);
      btn.element.setAttribute('aria-selected', String(selected));
      // タブは排他ボタンの見た目を借りるが、ARIA上は aria-pressed ではなく
      // aria-selected で選択状態を表す。
      btn.element.removeAttribute('aria-pressed');
    }
  }

  // タブ列を items へ丸ごと差し替える。SegmentedControl と同じく、同じ内容なら作り直さない。
  setItems(items: readonly (readonly [T, string])[]): void {
    // 同じ内容なら作り直さない — 差し替えると押しかけのタブが消えてクリックが届かなくなる。
    const same = (pair: readonly [T, string], i: number): boolean => {
      const cur = this.items[i];
      return cur !== undefined && pair[0] === cur[0] && pair[1] === cur[1];
    };
    if (items.length === this.items.length && items.every(same)) return;
    // 内容が変わった分だけ全タブを組み直す。
    for (const btn of this.buttons.values()) btn.element.remove();
    this.buttons.clear();
    for (const [value, label] of items) {
      const btn = new Button(label, () => this.onSelect(value));
      btn.element.setAttribute('role', 'tab');
      this.element.appendChild(btn.element);
      this.buttons.set(value, btn);
    }
    this.items = items.map(([value, label]) => [value, label] as const);
  }

  // 値に対応するタブボタンの要素。タブ本体との aria-controls の紐付けなど、呼び出し側が
  // ボタンへ直接属性を足したいときに使う。
  buttonFor(value: T): HTMLElement | undefined {
    return this.buttons.get(value)?.element;
  }
}
