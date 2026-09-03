// 見出し + 1つ以上のドロップダウン選択。反映ボタンを添えると、選択の変更自体は onApply を
// 呼ばず、ボタンを押した時点の各選択値をまとめて一度だけ通知する(値入力の確定契約とは別の
// 規約)。添えなければ選び直した時点で通知する。
import { Button } from './button';
import { buildLabeledRow, expandHitTarget, stopDragPropagation } from './widget-base';

export interface PulldownColumn<T> {
  readonly items: readonly (readonly [T, string])[];
  // ホバー説明とタッチ向け aria-label。同じ見た目のドロップダウンが複数並ぶとき、
  // どちらが何の選択かを見分ける手掛かりになる。
  readonly description?: string;
}

type ColumnValues<Cols extends readonly PulldownColumn<unknown>[]> = {
  [K in keyof Cols]: Cols[K] extends PulldownColumn<infer V> ? V : never;
};

export class Pulldown<Cols extends readonly PulldownColumn<unknown>[]> {
  public readonly element: HTMLElement;
  private readonly selects: readonly HTMLSelectElement[];
  private readonly columns: Cols;
  // 列ごとに直近で外部状態から反映した値。setSelected() は毎フレーム呼ばれるが、この値と
  // 変わっていなければ selectedIndex に触れない——毎フレーム書き込むと、セットボタンへの
  // クリックがフォーカスを外してから click イベントが発火するまでの一瞬に setSelected の
  // 呼び出しが割り込み、ユーザーが選び直した内容を反映前に元へ戻してしまう
  // (フォーカス中判定だけでは防げない)。
  private readonly lastSynced = new Map<number, unknown>();

  // columns は左から並ぶドロップダウンの列。onApply は各列の選択値を列の順に並べたタプルを受け取る。
  // applyLabel に null を渡すと反映ボタンを持たず、選び直した時点で onApply を呼ぶ。
  public constructor(title: string, columns: Cols, applyLabel: string | null, onApply: (values: ColumnValues<Cols>) => void) {
    this.columns = columns;
    this.element = buildLabeledRow(title);
    this.selects = columns.map((column) => {
      const select = document.createElement('select');
      select.className = 'w-select';
      stopDragPropagation(select);
      expandHitTarget(select);
      // 打鍵をゲーム操作と誤認されないよう伝播を止める。
      select.addEventListener('keydown', (e) => e.stopPropagation());
      if (column.description !== undefined) {
        select.title = column.description;
        select.setAttribute('aria-label', column.description);
      }
      for (const [, label] of column.items) {
        const option = document.createElement('option');
        option.textContent = label;
        select.appendChild(option);
      }
      this.element.appendChild(select);
      return select;
    });
    const notify = (): void => {
      const values = this.selects.map((select, i) => this.columns[i]?.items[select.selectedIndex]?.[0]);
      if (values.every((v) => v !== undefined)) onApply(values as ColumnValues<Cols>);
    };
    if (applyLabel === null) {
      for (const select of this.selects) select.addEventListener('change', notify);
      return;
    }
    this.element.appendChild(new Button(applyLabel, notify).element);
  }

  // columnIndex 列目の選択位置を外部状態(value)へ合わせる(この経路では onApply を呼ばない)。
  // 前回合わせた値から変わっていなければ何もしない——毎フレーム呼ばれるため、無条件に書き込むと
  // ユーザーが選び直した内容を反映前に消してしまう。
  public setSelected<K extends keyof Cols & number>(columnIndex: K, value: ColumnValues<Cols>[K]): void {
    if (this.lastSynced.get(columnIndex) === value) return;
    this.lastSynced.set(columnIndex, value);
    const select = this.selects[columnIndex];
    const column = this.columns[columnIndex];
    if (select === undefined || column === undefined) return;
    const index = column.items.findIndex(([v]) => v === value);
    if (index >= 0) select.selectedIndex = index;
  }
}
