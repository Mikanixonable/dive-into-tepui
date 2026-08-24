// 見出し + 排他選択のボタン列。3択以上の排他選択専用 — 2択の ON/OFF には ToggleSwitch を使う
// (SegmentedControl を2値トグルとして使わない)。
import { Button } from './button';

// T は Map のキーとして参照同一性で引ければ足りる(文字列に限らない —
// 座標系の ReferenceFrame オブジェクトなど、正準インスタンスの集合から選ぶ値も扱う)。
export class SegmentedControl<T> {
  readonly element: HTMLElement;
  private readonly buttons = new Map<T, Button>();
  private items: readonly (readonly [T, string, string?])[] = [];
  private readonly onSelect: (value: T) => void;

  // items は [値, 表示ラベル, 任意のアイコンマークアップ] の並びで、その順にボタンを並べる。
  constructor(title: string, items: readonly (readonly [T, string, string?])[], onSelect: (value: T) => void) {
    this.onSelect = onSelect;
    this.element = document.createElement('div');
    this.element.className = 'w-group';
    if (title !== '') {
      const heading = document.createElement('span');
      heading.className = 'w-group-title';
      heading.textContent = title;
      this.element.appendChild(heading);
    }
    this.setItems(items);
  }

  // 選択中の値を点灯させる。候補外の値(ラベルメニューから選んだフォーカスなど)と null では全消灯になる。
  setSelected(value: T | null): void {
    for (const [v, btn] of this.buttons) btn.setOn(v === value);
  }

  // ボタン列を items へ丸ごと差し替える(見出しはそのまま)。選べない選択肢を出してから
  // 拒否するのではなく、状況によって選択肢自体を絞りたい呼び出し側のために用意する。
  setItems(items: readonly (readonly [T, string, string?])[]): void {
    // 同じ内容なら作り直さない — 差し替えると押しかけのボタンが消えてクリックが届かなくなる。
    const same = (triple: readonly [T, string, string?], i: number): boolean => {
      const cur = this.items[i];
      return cur !== undefined && triple[0] === cur[0] && triple[1] === cur[1] && triple[2] === cur[2];
    };
    if (items.length === this.items.length && items.every(same)) return;
    for (const btn of this.buttons.values()) btn.element.remove();
    this.buttons.clear();
    for (const [value, label, icon] of items) {
      const btn = new Button(label, () => this.onSelect(value), icon);
      this.element.appendChild(btn.element);
      this.buttons.set(value, btn);
    }
    this.items = items.map(([value, label, icon]) => [value, label, icon] as const);
  }
}
