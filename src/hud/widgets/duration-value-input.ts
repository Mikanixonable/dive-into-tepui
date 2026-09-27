// 秒数の数値入力と単位(時・日・月・年)の切り替えを組み合わせた入力部品。
import { SegmentedControl } from './segmented-control';
import { ValueInput } from './value-input';

// 単位換算後の秒数を入力欄へ表示する文字列に丸める。小数第3位以降を切り捨てて
// 桁の長い割り切れない値(例: 1時間を「日」単位にした 0.041666...)を防ぐ。
function fmtInputSec(sec: number): string {
  return String(Math.round(sec * 100) / 100);
}

export type DurationUnit = 'hour' | 'day' | 'month' | 'year';

const UNIT_SEC: Record<DurationUnit, number> = { hour: 3600, day: 86400, month: 30 * 86400, year: 365 * 86400 };

const UNITS: readonly (readonly [DurationUnit, string])[] = [
  ['hour', '時'],
  ['day', '日'],
  ['month', '月'],
  ['year', '年'],
];

// 値(数値入力)+単位(SegmentedControl)の組。確定操作(Enter/blur/外部からの commit())でのみ
// クランプ後の秒数を通知する — 打鍵ごとに書き戻すと入力途中の値が壊れて打ち直せなくなるため。
// 空欄・非数値での確定、または Escape/cancel() は「変更なし」として現在の表示へ戻す。
export class DurationValueInput {
  public readonly element: HTMLElement;
  private readonly value: ValueInput;
  private readonly unit: SegmentedControl<DurationUnit>;
  private unitValue: DurationUnit;
  private minSec = 0;
  private maxSec = Infinity;
  private lastSec = 0;

  // onCommit は Enter・blur・確定ボタンで確定した値だけを1回ずつ通知する。
  public constructor(
    defaultUnit: DurationUnit,
    private readonly onCommit: (sec: number) => void,
    private readonly onCancel: () => void,
  ) {
    this.unitValue = defaultUnit;
    this.element = document.createElement('span');
    this.element.className = 'w-group predict-value-input';
    // 単位ボタンを押しても数値欄からフォーカスを移さない — 移すと blur が確定として走り、
    // 選び直した単位が反映される前に古い単位の値で閉じてしまう。フォーカス移動の既定動作を
    // 持つのは mousedown なので、それを捕捉段階で止める。
    this.element.addEventListener('mousedown', (e) => {
      if (e.target !== this.value.element) e.preventDefault();
    }, true);
    // 数値入力欄そのものは ValueInput へ委譲する。レンジへのクランプは commitText で行う —
    // ValueInput 自身は非有限値/空欄しか破棄しない。
    this.value = new ValueInput({ type: 'number', step: 1 }, (text) => this.commitText(text), () => this.onCancel());
    this.element.appendChild(this.value.element);
    // 単位切り替え。min/max とその時点の秒数を、新しい単位での表示値に引き直す。
    this.unit = new SegmentedControl('', UNITS, (u) => {
      this.unitValue = u;
      this.unit.setSelected(u);
      this.syncMinMaxAttr();
      this.value.setValue(fmtInputSec(this.lastSec / UNIT_SEC[u]));
    });
    this.unit.setSelected(this.unitValue);
    this.element.appendChild(this.unit.element);
  }

  // 秒数を今の単位での表示値に変換して入力欄へ反映し、フォーカスする。
  public openWithSec(sec: number, minSec: number, maxSec: number): void {
    this.syncSec(sec, minSec, maxSec);
    this.value.element.focus();
    this.value.element.select();
  }

  // 秒数を今の単位での表示値に反映するだけで、フォーカスは奪わない。常時表示の入力欄を
  // 外部状態に同期させるときに使う — 呼び出し側は編集中(フォーカス中)なら呼ばないこと。
  public syncSec(sec: number, minSec: number, maxSec: number): void {
    this.lastSec = sec;
    this.minSec = minSec;
    this.maxSec = maxSec;
    this.syncMinMaxAttr();
    this.value.setValue(fmtInputSec(sec / UNIT_SEC[this.unitValue]));
  }

  // ValueInput が確定した生の文字列をレンジへクランプして通知する。
  private commitText(text: string): void {
    const unitSec = UNIT_SEC[this.unitValue];
    const sec = Math.max(this.minSec, Math.min(this.maxSec, Number(text) * unitSec));
    this.lastSec = sec;
    this.value.setValue(fmtInputSec(sec / unitSec));
    this.onCommit(sec);
  }

  // 編集中の値を確定させる。レンジへ収めたうえで onCommit が1回だけ呼ばれる。
  public commit(): void {
    this.value.commit();
  }

  // 編集を破棄する。
  public cancel(): void {
    this.value.cancel();
  }

  // 編集中(フォーカス中)かどうか。常時表示の入力欄を外部状態で上書きしてよいかの判定に使う。
  public get focused(): boolean {
    return document.activeElement === this.value.element;
  }

  // 入力欄の min/max 属性を現在の単位での表示値に換算して合わせる(ブラウザのスピンボタン用の
  // ヒントで、実際のクランプは commitText が担う)。
  private syncMinMaxAttr(): void {
    const unitSec = UNIT_SEC[this.unitValue];
    this.value.element.min = String(this.minSec / unitSec);
    if (isFinite(this.maxSec)) this.value.element.max = String(this.maxSec / unitSec);
    else this.value.element.removeAttribute('max');
  }
}
