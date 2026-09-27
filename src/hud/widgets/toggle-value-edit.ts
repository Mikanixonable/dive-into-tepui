// 「表示用要素 ⇔ 数値入力(DurationValueInput)」の開閉を1つ受け持つ。open() で表示用要素を
// 隠して数値入力を出し、確定・取り消しで自動的に close() して表示用要素へ戻す。
import { DurationValueInput, type DurationUnit } from './duration-value-input';

export class ToggleValueEdit {
  private readonly input: DurationValueInput;
  private editingValue = false;

  // displayEl と editEl を入れ替える組を作る。確定した秒数を onCommit へ渡し、確定・取り消しの
  // どちらでも表示用要素へ戻る。
  public constructor(
    private readonly displayEl: HTMLElement,
    private readonly editEl: HTMLElement,
    defaultUnit: DurationUnit,
    onCommit: (sec: number) => void,
  ) {
    this.input = new DurationValueInput(
      defaultUnit,
      (sec) => { onCommit(sec); this.close(); },
      () => this.close(),
    );
  }

  // 数値入力へ差し替わっている間だけ真。
  public get editing(): boolean {
    return this.editingValue;
  }

  // 数値入力の要素。editEl の中へ置く。
  public get inputEl(): HTMLElement {
    return this.input.element;
  }

  // 表示用要素を数値入力フォームへ差し替え、指定した秒数を初期値として入れる。
  public open(sec: number, minSec: number, maxSec: number): void {
    this.editingValue = true;
    this.displayEl.classList.add('hidden');
    this.editEl.classList.remove('hidden');
    this.input.openWithSec(sec, minSec, maxSec);
  }

  // 数値入力フォームを閉じ、表示用要素へ戻す。
  public close(): void {
    this.editingValue = false;
    this.editEl.classList.add('hidden');
    this.displayEl.classList.remove('hidden');
  }

  // 開いている数値入力を確定させて閉じる。
  public commit(): void {
    this.input.commit();
  }

  // 開いている数値入力を破棄して閉じる。
  public cancel(): void {
    this.input.cancel();
  }
}
