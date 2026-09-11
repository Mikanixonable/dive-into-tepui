// クリエイティブモードの開始日時の入力欄(GAME.md 9.0)。年/月/日/時/分の5欄を持ち、
// 有効な日時のときだけ開始ボタンを押せる。開始すると、入力した日時をランの元期として通知する。
import { Button, ValueInput } from '../hud/widgets';
import { calendarDateToJulianDate, julianDateToCalendarDate, parseCalendarDate } from '../physics/time';
import type { StageClass } from '../game/stages/stage';
import type { TdbJulianDate } from '../physics/time';

const FIELD_LABELS = ['年', '月', '日', '時', '分'] as const;

export class StartEpochForm {
  public readonly element = document.createElement('div');
  private readonly inputs: readonly ValueInput[];
  private readonly errorMessage = document.createElement('p');
  private readonly startButton: Button;
  // 入力した日時で始めるステージ。open で決まる。
  private stageClass: StageClass | null = null;
  private opened = false;

  // 構築直後は隠れている。onStart は開始ボタンで、開いたステージと入力した元期を渡して呼ばれる。
  // onBack は戻るボタンで、入力欄を隠したあとに呼ばれる。
  public constructor(
    onStart: (stageClass: StageClass, startEpoch: TdbJulianDate) => void,
    onBack: () => void,
  ) {
    // 見出し・5欄・エラーメッセージ・操作ボタンを上から積む。
    this.element.className = 'ss-datetime hidden';
    const title = document.createElement('p');
    title.className = 'ss-window-title';
    title.textContent = '開始日時';
    const fields = document.createElement('div');
    fields.className = 'ss-datetime-fields';
    this.errorMessage.className = 'ss-datetime-error';
    this.errorMessage.textContent = '存在しない日時です。';
    const actions = document.createElement('div');
    actions.className = 'ss-datetime-actions';
    this.element.append(title, fields, this.errorMessage, actions);

    // 各欄は確定でも打鍵でも入力値を検証し直す。
    this.inputs = FIELD_LABELS.map((label) => {
      const field = document.createElement('label');
      field.className = 'ss-datetime-field';
      const span = document.createElement('span');
      span.textContent = label;
      const input = new ValueInput({ type: 'number', step: 1 }, () => this.validate());
      input.element.addEventListener('input', () => this.validate());
      field.append(span, input.element);
      fields.appendChild(field);
      return input;
    });

    this.startButton = new Button('開始', () => {
      const startEpoch = this.readEpoch();
      if (startEpoch === null || this.stageClass === null) return;
      onStart(this.stageClass, startEpoch);
    });
    const backButton = new Button('戻る', () => {
      this.opened = false;
      this.element.classList.add('hidden');
      onBack();
    });
    actions.append(backButton.element, this.startButton.element);
    this.validate();
  }

  // 入力欄が出ているか。
  public get isOpen(): boolean {
    return this.opened;
  }

  // stageClass が宣言した日時を5欄の既定値に入れて、入力欄を出す。既定値はステージごとに違うので
  // 開くたびに入れ直す。
  public open(stageClass: StageClass): void {
    this.stageClass = stageClass;
    const epoch = julianDateToCalendarDate(stageClass.epoch);
    const initials = [epoch.year, epoch.month, epoch.day, epoch.hour, epoch.minute];
    for (const [i, input] of this.inputs.entries()) input.setValue(String(initials[i]));
    this.validate();
    this.opened = true;
    this.element.classList.remove('hidden');
  }

  // 5欄の入力値が指す絶対時刻。数値でない/存在しない日時なら null。
  private readEpoch(): TdbJulianDate | null {
    if (this.inputs.some((input) => input.element.value.trim() === '' || !isFinite(Number(input.element.value)))) return null;
    const [year, month, day, hour, minute] =
      this.inputs.map((input) => Number(input.element.value)) as [number, number, number, number, number];
    if (year < 0) return null;
    // parseCalendarDate が要求する拡張 ISO 形式(年は4桁、月日時分は2桁)。
    const iso = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00`;
    try {
      return calendarDateToJulianDate(parseCalendarDate(iso, 'TDB'));
    } catch {
      return null;
    }
  }

  // 開始ボタンの有効/無効とエラーメッセージを、いまの入力値に合わせる。
  private validate(): void {
    const startEpoch = this.readEpoch();
    this.startButton.setEnabled(startEpoch !== null);
    this.errorMessage.classList.toggle('hidden', startEpoch !== null);
  }
}

// n を2桁へ0詰めした文字列。
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
