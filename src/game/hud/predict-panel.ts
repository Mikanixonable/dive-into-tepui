// 未来表示の操作パネル(期間ピル・スクラバー・目盛り)。3行構成: 期間選択 / スクラブバー+T+読み値 / 目盛り。
import * as C from '../const';
import { Button, SegmentedControl, Slider, ToggleSwitch, ValueInput, syncCollapseToggle } from './widgets';
import { buildCollapseToggle, PREDICT_TOGGLE_LABELS } from './hud-root';
import { loadPanelCollapsed, onPanelCollapsedViewChange, savePanelCollapsed } from './panel-shell';
import { SIM_EPOCH_SEC, fmtDateTime, fmtDuration } from './utils';
import type { DisplayDurationKey, DisplayPastDurationKey } from '../display-window-manager';
import type { TickLabelMode } from './calendar-ticks';
import type { DisplayTick } from './tick-scale';

type FixedDurationKey = 'orbit' | 'day' | 'week' | 'month';

const FIXED_DURATIONS: readonly (readonly [FixedDurationKey, string])[] = [
  ['orbit', '1周'],
  ['day', '1日'],
  ['week', '7日'],
  ['month', '28日'],
];

type FixedPastDurationKey = 'none' | FixedDurationKey;

const FIXED_PAST_DURATIONS: readonly (readonly [FixedPastDurationKey, string])[] = [
  ['none', 'なし'],
  ...FIXED_DURATIONS,
];

type DurationUnit = 'hour' | 'day' | 'month' | 'year';

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
class DurationValueInput {
  public readonly element: HTMLElement;
  private readonly value: ValueInput;
  private readonly unit: SegmentedControl<DurationUnit>;
  private unitValue: DurationUnit;
  private minSec = 0;
  private maxSec = Infinity;

  // onCommit は Enter・blur・確定ボタンでのみ呼ばれる — 呼び出し側は打鍵ごとの値を追う必要がない。
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
    this.value = new ValueInput({ type: 'number' }, (text) => this.commitText(text), () => this.onCancel());
    this.element.appendChild(this.value.element);
    // 単位切り替え。単位が変わると min/max の表示値も単位に合わせて引き直す。
    this.unit = new SegmentedControl('', UNITS, (u) => {
      this.unitValue = u;
      this.unit.setSelected(u);
      this.syncMinMaxAttr();
    });
    this.unit.setSelected(this.unitValue);
    this.element.appendChild(this.unit.element);
  }

  // 秒数を今の単位での表示値に変換して入力欄へ反映し、フォーカスする。
  public openWithSec(sec: number, minSec: number, maxSec: number): void {
    this.minSec = minSec;
    this.maxSec = maxSec;
    this.syncMinMaxAttr();
    this.value.setValue(String(sec / UNIT_SEC[this.unitValue]));
    this.value.element.focus();
    this.value.element.select();
  }

  // ValueInput が確定した生の文字列をレンジへクランプして通知する。
  private commitText(text: string): void {
    const unitSec = UNIT_SEC[this.unitValue];
    const sec = Math.max(this.minSec, Math.min(this.maxSec, Number(text) * unitSec));
    this.value.setValue(String(sec / unitSec));
    this.onCommit(sec);
  }

  public commit(): void {
    this.value.commit();
  }

  // 編集を破棄する。
  public cancel(): void {
    this.value.cancel();
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

// 任意期間のピルに出す秒数の表記。固定プリセットのピル(1日/7日/28日)と並ぶので、
// 単位は UNITS と同じ和字にし、割り切れる中で最も大きい単位を選ぶ。割り切れる単位が
// 無ければ分・秒まで落として正確な値を出す(丸めて精度を落とさない)。
function customPillLabel(sec: number): string {
  for (let i = UNITS.length - 1; i >= 0; i--) {
    const unit = UNITS[i];
    if (unit === undefined) continue;
    const unitSec = UNIT_SEC[unit[0]];
    if (sec >= unitSec && sec % unitSec === 0) return `${sec / unitSec}${unit[1]}`;
  }
  if (sec % 60 === 0) return `${sec / 60}分`;
  return `${Math.round(sec)}秒`;
}

// フォーカス移動による commit() の割り込みを避けつつ押せる小ボタン(✓/✕ など)。
function inlineIconButton(label: string, title: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('span');
  btn.className = 'predict-edit-btn';
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  btn.addEventListener('click', () => onClick());
  return btn;
}

// 表示用の要素と編集用の要素を排他に切り替える(常にどちらか一方だけが hidden でない)。
class EditSlot {
  private editingFlag = false;

  public constructor(private readonly displayEl: HTMLElement, private readonly editEl: HTMLElement) {}

  public get editing(): boolean {
    return this.editingFlag;
  }

  public open(): void {
    this.editingFlag = true;
    this.displayEl.classList.add('hidden');
    this.editEl.classList.remove('hidden');
  }

  public close(): void {
    this.editingFlag = false;
    this.editEl.classList.add('hidden');
    this.displayEl.classList.remove('hidden');
  }
}

// 「見出し + 固定期間ピル列 + 任意…ピル」の1行。任意…を押すとピル列を数値入力フォームへ
// 差し替え、確定・取り消しでピル列へ戻る。K は固定ピルのキー、Kd は選択状態として受け取る
// キー(固定ピルに加えて 'custom' を含む)。
class DurationPillRow<K extends string, Kd extends string> {
  public readonly element: HTMLElement;
  private readonly buttons = new Map<K, Button>();
  private readonly pillsEl: HTMLElement;
  private readonly customPillBtn: Button;
  private readonly editEl: HTMLElement;
  private readonly input: DurationValueInput;
  private readonly editSlot: EditSlot;
  private currentSec = C.DISPLAY_DUR_DAY;

  public constructor(
    title: string,
    entries: readonly (readonly [K, string])[],
    private readonly onSelect: (key: K) => void,
    private readonly onCustomConfirm: (sec: number) => void,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'predict-row1';
    const label = document.createElement('span');
    label.className = 'w-group-title';
    label.textContent = title;
    this.element.appendChild(label);

    this.pillsEl = document.createElement('span');
    this.pillsEl.className = 'predict-pills';
    for (const [key, text] of entries) {
      const btn = new Button(text, () => this.onSelect(key));
      this.pillsEl.appendChild(btn.element);
      this.buttons.set(key, btn);
    }
    this.customPillBtn = new Button('任意…', () => this.openEdit());
    this.pillsEl.appendChild(this.customPillBtn.element);
    this.element.appendChild(this.pillsEl);

    this.input = new DurationValueInput(
      'day',
      (sec) => { this.onCustomConfirm(sec); this.closeEdit(); },
      () => this.closeEdit(),
    );
    this.editEl = document.createElement('span');
    this.editEl.className = 'predict-pills hidden';
    this.editEl.appendChild(this.input.element);
    this.editEl.appendChild(inlineIconButton('✓', '確定', () => this.input.commit()));
    this.editEl.appendChild(inlineIconButton('✕', 'キャンセル', () => this.input.cancel()));
    this.element.appendChild(this.editEl);
    this.editSlot = new EditSlot(this.pillsEl, this.editEl);
  }

  // 選択中のキーと、任意…ピルに出す秒数を反映する。currentSec は任意…を開いたときの初期値。
  // 編集中の行はユーザー入力を壊さないよう書き換えない。
  public render(key: Kd, customDurationSec: number, currentSec: number): void {
    this.currentSec = currentSec;
    if (this.editSlot.editing) return;
    for (const [k, btn] of this.buttons) btn.setOn(k === (key as string));
    this.customPillBtn.setOn(key === 'custom');
    const label = key === 'custom' ? `${customPillLabel(customDurationSec)} ✎` : '任意…';
    if (this.customPillBtn.element.textContent !== label) this.customPillBtn.setLabel(label);
  }

  // ピル列を数値入力フォームへ差し替え、直近に受け取った秒数を初期値として入れる。
  private openEdit(): void {
    this.editSlot.open();
    this.input.openWithSec(Math.max(C.DISPLAY_DURATION_MIN, this.currentSec), C.DISPLAY_DURATION_MIN, C.DISPLAY_DURATION_MAX);
  }

  // 数値入力フォームを閉じ、ピル列へ戻す。
  private closeEdit(): void {
    this.editSlot.close();
  }
}

export interface PredictPanelState {
  readonly visible: boolean;
  readonly durationKey: DisplayDurationKey;
  readonly customDurationSec: number;
  readonly pastDurationKey: DisplayPastDurationKey;
  readonly customPastDurationSec: number;
  readonly pastDuration: number;
  readonly tickLabelMode: TickLabelMode;
  readonly showTicks: boolean;
  readonly duration: number;
  readonly displayTime: number;
  readonly sliderSteps: number;
  readonly sliderT: number;
  readonly predictionRatio: number;
  readonly ticks: readonly DisplayTick[];
}

export class PredictPanel {
  public onDurationSelect: ((key: FixedDurationKey) => void) | null = null;
  public onCustomDurationConfirm: ((sec: number) => void) | null = null;
  public onPastDurationSelect: ((key: FixedPastDurationKey) => void) | null = null;
  public onPastCustomDurationConfirm: ((sec: number) => void) | null = null;
  public onTickLabelModeChange: ((mode: TickLabelMode) => void) | null = null;
  public onShowTicksChange: ((show: boolean) => void) | null = null;
  public onSliderChange: ((t: number) => void) | null = null;
  public onResetToNow: (() => void) | null = null;
  public onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
  private readonly pastDurationRow: DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>;
  private readonly pastToggleBtn: Button;
  private readonly tickLabelModeSwitch: ToggleSwitch;
  private readonly showTicksSwitch: ToggleSwitch;
  private readonly slider: Slider;
  private readonly absoluteLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly jumpEditEl: HTMLElement;
  private readonly jumpInput: DurationValueInput;
  private readonly jumpEditSlot: EditSlot;
  private readonly ticks: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  private sliderSteps = 1000;
  private currentDuration = C.APERIODIC_ARC_DURATION;
  private lastTrackRatio = 1;

  // PREDICT パネルの DOM を組み立て、root へ追加する。
  public constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '軌道予測';
    this.panel.appendChild(title);

    // 行1: 未来の期間ピル(1周/1日/7日/28日/任意…)。行末の「過去 ▸」は既定で畳んだ過去行の開閉。
    this.durationRow = new DurationPillRow<FixedDurationKey, DisplayDurationKey>(
      '未来', FIXED_DURATIONS,
      (key) => this.onDurationSelect?.(key),
      (sec) => this.onCustomDurationConfirm?.(sec),
    );
    this.pastToggleBtn = new Button('', () => this.togglePastRow());
    this.pastToggleBtn.element.classList.add('predict-past-toggle');
    this.durationRow.element.appendChild(this.pastToggleBtn.element);
    this.panel.appendChild(this.durationRow.element);

    // 過去の期間ピル(未来行と同形、さらに なし)。既定は「なし」が主用途なので畳んで始める。
    this.pastDurationRow = new DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>(
      '過去', FIXED_PAST_DURATIONS,
      (key) => this.onPastDurationSelect?.(key),
      (sec) => this.onPastCustomDurationConfirm?.(sec),
    );
    this.pastDurationRow.element.classList.add('predict-past');
    this.panel.appendChild(this.pastDurationRow.element);
    this.applyPastRowCollapsed(loadPanelCollapsed('hud-predict-past') ?? true);

    // 目盛りラベルの表記(UTC カレンダー / 現在からの経過時間)はスクラバー行に同居させる。
    this.tickLabelModeSwitch = new ToggleSwitch(
      '相対表記',
      (on) => this.onTickLabelModeChange?.(on ? 'relative' : 'absolute'),
    );
    this.tickLabelModeSwitch.element.classList.add('predict-tick-mode');

    // 目盛り行自体の表示可否。
    this.showTicksSwitch = new ToggleSwitch(
      '目盛りを表示',
      (on) => this.onShowTicksChange?.(on),
    );
    this.showTicksSwitch.element.classList.add('predict-tick-visibility');

    // 行2: 現在に戻すボタン + スクラバー + T+読み値(クリックで直接ジャンプ入力に変わる)。
    const row2 = document.createElement('div');
    row2.className = 'predict-row2';
    const resetBtn = new Button('⏮', () => this.onResetToNow?.());
    resetBtn.element.classList.add('predict-reset');
    resetBtn.element.title = '現在に戻す';
    resetBtn.element.setAttribute('aria-label', '現在に戻す');
    row2.appendChild(resetBtn.element);

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'predict-slider-wrap';
    this.slider = new Slider(
      { min: 0, max: this.sliderSteps },
      (value) => this.onSliderChange?.(value / this.sliderSteps),
    );
    this.slider.element.title = 'ドラッグ、またはトラックをクリックして未来位置を選ぶ';
    this.slider.element.setAttribute('aria-label', '未来位置');
    sliderWrap.appendChild(this.slider.element);
    row2.appendChild(sliderWrap);

    this.absoluteLabel = document.createElement('span');
    this.absoluteLabel.className = 'predict-absolute';
    row2.appendChild(this.absoluteLabel);

    this.elapsedLabel = document.createElement('span');
    this.elapsedLabel.className = 'predict-elapsed';
    this.elapsedLabel.title = 'クリックして時刻へジャンプ';
    this.elapsedLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.elapsedLabel.addEventListener('click', () => this.openJumpEdit());
    row2.appendChild(this.elapsedLabel);

    this.jumpInput = new DurationValueInput(
      'hour',
      (sec) => { this.onJumpToTime?.(sec); this.closeJumpEdit(); },
      () => this.closeJumpEdit(),
    );
    this.jumpEditEl = document.createElement('span');
    this.jumpEditEl.className = 'predict-value-input hidden';
    this.jumpEditEl.appendChild(this.jumpInput.element);
    row2.appendChild(this.jumpEditEl);
    this.jumpEditSlot = new EditSlot(this.elapsedLabel, this.jumpEditEl);
    row2.appendChild(this.showTicksSwitch.element);
    row2.appendChild(this.tickLabelModeSwitch.element);
    this.panel.appendChild(row2);

    // 行3: 目盛り。スクラバーの直下に置く。
    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    this.panel.appendChild(this.ticks);

    // トグルとバー本体を1つの縦積み flex にまとめ、バーを畳んでもトグルだけがその場に残るようにする。
    this.wrap = document.createElement('div');
    this.wrap.id = 'hud-predict-wrap';
    this.wrap.appendChild(this.panel);
    const collapseToggle = buildCollapseToggle(this.wrap, 'hud-predict-toggle', '', this.panel, PREDICT_TOGGLE_LABELS);
    const applyCollapsedState = (): void => {
      const collapsed = loadPanelCollapsed('hud-predict') ?? false;
      this.panel.classList.toggle('collapsed', collapsed);
      syncCollapseToggle(collapseToggle, this.panel, PREDICT_TOGGLE_LABELS);
    };
    applyCollapsedState();
    this.unsubscribeCollapsedView = onPanelCollapsedViewChange(applyCollapsedState);
    collapseToggle.addEventListener('click', () => savePanelCollapsed('hud-predict', this.panel.classList.contains('collapsed')));
    root.appendChild(this.wrap);
  }

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  public render(state: PredictPanelState): void {
    this.setVisible(state.visible);
    if (!state.visible) return;
    this.currentDuration = state.duration;
    this.durationRow.render(state.durationKey, state.customDurationSec, state.duration);
    this.pastDurationRow.render(state.pastDurationKey, state.customPastDurationSec, state.pastDuration);
    this.tickLabelModeSwitch.setOn(state.tickLabelMode === 'relative');
    this.showTicksSwitch.setOn(state.showTicks);
    this.ticks.classList.toggle('hidden', !state.showTicks);
    this.renderSlider(state.sliderSteps, state.sliderT, state.predictionRatio);
    this.renderAbsoluteLabel(state.displayTime);
    if (!this.jumpEditSlot.editing) this.renderElapsedLabel(state.sliderT * state.duration);
    this.renderTicks(state.ticks);
  }

  private setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // パネルの DOM を取り除き、折りたたみ状態変化の購読を解く。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.wrap.remove();
  }

  private togglePastRow(): void {
    const collapsed = !this.pastDurationRow.element.classList.contains('collapsed');
    this.applyPastRowCollapsed(collapsed);
    savePanelCollapsed('hud-predict-past', collapsed);
  }

  // 過去行の開閉を反映し、トグルボタンの見た目(向き・タイトル)も合わせる。
  private applyPastRowCollapsed(collapsed: boolean): void {
    this.pastDurationRow.element.classList.toggle('collapsed', collapsed);
    this.pastToggleBtn.setLabel(collapsed ? '過去 ▸' : '過去 ▾');
    const title = collapsed ? '過去表示を開く' : '過去表示を畳む';
    this.pastToggleBtn.element.title = title;
    this.pastToggleBtn.element.setAttribute('aria-label', title);
  }

  // スライダーの段階数・つまみ位置・未予測区間の表示を反映する。
  private renderSlider(steps: number, t: number, predictionRatio: number): void {
    if (steps !== this.sliderSteps) {
      this.sliderSteps = steps;
      this.slider.element.max = String(steps);
    }
    const value = Math.round(t * this.sliderSteps);
    if (this.slider.getValue() !== value) this.slider.setValue(value);
    if (predictionRatio !== this.lastTrackRatio) {
      this.lastTrackRatio = predictionRatio;
      // <input type=range> はトラック上の区間ごとに色を分けられないので、
      // 背景グラデーションで未予測区間の減光を表す。
      this.slider.setGradient(predictionRatio);
    }
  }

  // 表示時刻を UTC の絶対日時で出す。T+ 表記は目盛りと同じ粗い単位なので、
  // 正確な時刻はこちらが受け持つ。
  private renderAbsoluteLabel(displayTime: number): void {
    const text = fmtDateTime(SIM_EPOCH_SEC + displayTime);
    if (this.absoluteLabel.textContent !== text) this.absoluteLabel.textContent = text;
  }

  // T+ 表記の経過時間を表示する。
  private renderElapsedLabel(elapsedSec: number): void {
    const text = `T+${fmtDuration(elapsedSec, elapsedSec)}`;
    if (this.elapsedLabel.textContent !== text) this.elapsedLabel.textContent = text;
  }

  // T+ 読み値を数値入力フォームへ差し替える。
  private openJumpEdit(): void {
    this.jumpEditSlot.open();
    this.jumpInput.openWithSec(this.currentDuration * (this.slider.getValue() / this.sliderSteps), 0, this.currentDuration);
  }

  // 数値入力フォームを閉じ、T+ 読み値を出す。
  private closeJumpEdit(): void {
    this.jumpEditSlot.close();
  }

  // 各目盛りをスライダー全域上の位置 t(0..1)へ置く。端に近い目盛りの寄せ方も t の値そのものから
  // 決める(:first-child/:last-child ではない — 最終目盛りが常に右端とは限らないため)。
  private renderTicks(ticks: readonly DisplayTick[]): void {
    if (this.ticks.childElementCount !== ticks.length) {
      this.ticks.innerHTML = '';
      for (let i = 0; i < ticks.length; i++) {
        const tick = document.createElement('span');
        this.ticks.appendChild(tick);
      }
    }
    // 本数が変わらない限り要素は使い回し、変わった値だけ書く。
    for (let i = 0; i < ticks.length; i++) {
      const el = this.ticks.children[i];
      const tick = ticks[i];
      if (el === undefined || tick === undefined || !(el instanceof HTMLElement)) continue;
      if (el.textContent !== tick.label) el.textContent = tick.label;
      const left = `${tick.t * 100}%`;
      if (el.style.left !== left) el.style.left = left;
      const transform = tick.t < 0.02 ? 'none' : tick.t > 0.98 ? 'translateX(-100%)' : 'translateX(-50%)';
      if (el.style.transform !== transform) el.style.transform = transform;
    }
  }
}
