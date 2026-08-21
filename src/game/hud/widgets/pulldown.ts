// 見出し + ドロップダウン選択 + 明示的な反映ボタン。選択の変更自体は onApply を呼ばない——
// 反映ボタンを押した時点の選択値だけを一度だけ通知する(値入力の確定契約・SegmentedControl
// の即時反映とは別の規約)。
import { Button } from './button';
import { expandHitTarget, stopDragPropagation } from './widget-base';

export class Pulldown<T> {
  readonly element: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly applyButton: Button;
  private items: readonly (readonly [T, string])[] = [];

  // items は [値, 表示ラベル] の並びで、その順に選択肢を並べる。applyLabel は反映ボタンの表示文字列。
  constructor(
    title: string,
    items: readonly (readonly [T, string])[],
    applyLabel: string,
    onApply: (value: T) => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'w-group';
    if (title !== '') {
      const heading = document.createElement('span');
      heading.className = 'w-group-title';
      heading.textContent = title;
      this.element.appendChild(heading);
    }
    this.select = document.createElement('select');
    this.select.className = 'w-select';
    stopDragPropagation(this.select);
    expandHitTarget(this.select);
    // Input と同じ理由(ゲーム側のキー入力監視への漏れ防止)でここでも伝播を止める。
    this.select.addEventListener('keydown', (e) => e.stopPropagation());
    this.element.appendChild(this.select);
    this.setItems(items);
    this.applyButton = new Button(applyLabel, () => {
      const value = this.items[this.select.selectedIndex]?.[0];
      if (value !== undefined) onApply(value);
    });
    this.element.appendChild(this.applyButton.element);
  }

  // ドロップダウンの選択位置だけを変える(反映ボタンを押すまで onApply は呼ばれない)。
  setSelected(value: T): void {
    const index = this.items.findIndex(([v]) => v === value);
    if (index >= 0) this.select.selectedIndex = index;
  }

  // 選択肢を items へ丸ごと差し替える(見出し・反映ボタンはそのまま)。
  setItems(items: readonly (readonly [T, string])[]): void {
    const same = (pair: readonly [T, string], i: number): boolean => {
      const cur = this.items[i];
      return cur !== undefined && pair[0] === cur[0] && pair[1] === cur[1];
    };
    if (items.length === this.items.length && items.every(same)) return;
    const selectedValue = this.items[this.select.selectedIndex]?.[0];
    this.select.textContent = '';
    for (const [, label] of items) {
      const option = document.createElement('option');
      option.textContent = label;
      this.select.appendChild(option);
    }
    this.items = items.map(([value, label]) => [value, label] as const);
    if (selectedValue !== undefined) this.setSelected(selectedValue);
  }
}
