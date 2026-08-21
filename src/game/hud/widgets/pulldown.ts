// 見出し + 1つ以上のドロップダウン選択 + 明示的な反映ボタン。選択の変更自体は onApply を
// 呼ばない——反映ボタンを押した時点の各選択値をまとめて一度だけ通知する(値入力の確定契約・
// SegmentedControl の即時反映とは別の規約)。
import { Button } from './button';
import { expandHitTarget, stopDragPropagation } from './widget-base';

export interface PulldownColumn<T> {
  readonly items: readonly (readonly [T, string])[];
}

type ColumnValues<Cols extends readonly PulldownColumn<unknown>[]> = {
  [K in keyof Cols]: Cols[K] extends PulldownColumn<infer V> ? V : never;
};

export class Pulldown<Cols extends readonly PulldownColumn<unknown>[]> {
  readonly element: HTMLElement;
  private readonly selects: readonly HTMLSelectElement[];
  private readonly columns: Cols;
  private readonly applyButton: Button;

  // columns は左から並ぶドロップダウンの列。onApply は各列の選択値を列の順に並べたタプルを受け取る。
  constructor(title: string, columns: Cols, applyLabel: string, onApply: (values: ColumnValues<Cols>) => void) {
    this.columns = columns;
    this.element = document.createElement('div');
    this.element.className = 'w-group';
    if (title !== '') {
      const heading = document.createElement('span');
      heading.className = 'w-group-title';
      heading.textContent = title;
      this.element.appendChild(heading);
    }
    this.selects = columns.map((column) => {
      const select = document.createElement('select');
      select.className = 'w-select';
      stopDragPropagation(select);
      expandHitTarget(select);
      // Input と同じ理由(ゲーム側のキー入力監視への漏れ防止)でここでも伝播を止める。
      select.addEventListener('keydown', (e) => e.stopPropagation());
      for (const [, label] of column.items) {
        const option = document.createElement('option');
        option.textContent = label;
        select.appendChild(option);
      }
      this.element.appendChild(select);
      return select;
    });
    this.applyButton = new Button(applyLabel, () => {
      const values = this.selects.map((select, i) => this.columns[i]?.items[select.selectedIndex]?.[0]);
      if (values.every((v) => v !== undefined)) onApply(values as ColumnValues<Cols>);
    });
    this.element.appendChild(this.applyButton.element);
  }

  // columnIndex 列目の選択位置だけを変える(反映ボタンを押すまで onApply は呼ばれない)。
  // 操作中(フォーカス中)は外部状態への同期で選び直しを上書きしない。
  setSelected<K extends keyof Cols & number>(columnIndex: K, value: ColumnValues<Cols>[K]): void {
    const select = this.selects[columnIndex];
    const column = this.columns[columnIndex];
    if (select === undefined || column === undefined || document.activeElement === select) return;
    const index = column.items.findIndex(([v]) => v === value);
    if (index >= 0) select.selectedIndex = index;
  }
}
