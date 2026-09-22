// 未来表示の操作パネル。未来/過去の期間ピル、目盛り表記の切り替え、表示時刻のスクラバーと
// 目盛り列を持つ。
import {
  buildLabeledRow, Button, PREDICT_TOGGLE_LABELS, SegmentedControl, Slider, ToggleSwitch, ValueInput,
} from '../../../hud/widgets';
import type { PanelCollapse } from '../panel-shell';
import { fmtDateTime, fmtDuration } from '../../../hud/utils';
import type { DisplayTick } from '../orbit/tick-scale';
import {
  APERIODIC_ARC_DURATION, DISPLAY_DURATION_MAX,
} from '../../viewer/predict-panel-selection';
import type {
  DisplayDurationKey, DisplayPastDurationKey, TickLabelMode,
} from '../../viewer/predict-panel-selection';

// 手動レンジで指定できる表示期間の下限 [s]。表示期間は予測列の保持窓でもあり、0 では
// サンプルが1件も残らず、どの時刻も引けない列になる。
const DISPLAY_DURATION_MIN = 3600;

// ピルで選べる期間。手動レンジ('custom')だけは入力欄が受け持つ。
type FixedDurationKey = Exclude<DisplayDurationKey, 'custom'>;
type FixedPastDurationKey = Exclude<DisplayPastDurationKey, 'custom'>;

const FIXED_DURATIONS: readonly (readonly [FixedDurationKey, string])[] = [
  ['orbit', '1周'],
  ['day', '1日'],
  ['tenDay', '10日'],
  ['month', '1ヶ月'],
  ['threeMonth', '3ヶ月'],
];

const FIXED_PAST_DURATIONS: readonly (readonly [FixedPastDurationKey, string])[] = [
  ['none', 'なし'],
  ...FIXED_DURATIONS,
];

// 単位換算後の秒数を入力欄へ表示する文字列に丸める。小数第3位以降を切り捨てて
// 桁の長い割り切れない値(例: 1時間を「日」単位にした 0.041666...)を防ぐ。
function fmtInputSec(sec: number): string {
  return String(Math.round(sec * 100) / 100);
}

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

// 「表示用要素 ⇔ 数値入力(DurationValueInput)」の開閉を1つ受け持つ。open() で表示用要素を
// 隠して数値入力を出し、確定・取り消しで自動的に close() して表示用要素へ戻す。
class ToggleValueEdit {
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

// 「見出し + 固定期間ピル列 + 常時表示の数値入力」の1行。数値入力を書き換えて確定すると
// 選択キーが 'custom' になる。K は固定ピルのキー、Kd は選択状態として受け取るキー
// (固定ピルに加えて 'custom' を含む)。
class DurationPillRow<K extends string, Kd extends K | 'custom'> {
  public readonly element: HTMLElement;
  private readonly buttons = new Map<K, Button>();
  private readonly input: DurationValueInput;

  // title を見出しにした1行を組む。ピルの押下は onSelect、数値入力の確定は onCustomConfirm。
  public constructor(
    title: string,
    entries: readonly (readonly [K, string])[],
    private readonly onSelect: (key: K) => void,
    onCustomConfirm: (sec: number) => void,
  ) {
    this.element = buildLabeledRow(title, 'predict-row1');

    // 固定期間のピルを並べ、末尾に手動レンジの入力欄を置く。
    const pillsEl = document.createElement('span');
    pillsEl.className = 'predict-pills';
    for (const [key, text] of entries) {
      const btn = new Button(text, () => this.onSelect(key));
      pillsEl.appendChild(btn.element);
      this.buttons.set(key, btn);
    }
    this.element.appendChild(pillsEl);

    this.input = new DurationValueInput('day', onCustomConfirm, () => {});
    this.element.appendChild(this.input.element);
  }

  // 選択中のキーと、数値入力欄に示す秒数を反映する。入力欄は編集中(フォーカス中)なら
  // ユーザー入力を壊さないよう書き換えない。
  public render(key: Kd, currentSec: number): void {
    for (const [k, btn] of this.buttons) btn.setOn(key === k);
    if (!this.input.focused) this.input.syncSec(currentSec, DISPLAY_DURATION_MIN, DISPLAY_DURATION_MAX);
  }
}

// 未来表示パネルが1フレームに映す値。
interface PredictPanelState {
  readonly visible: boolean;
  readonly durationKey: DisplayDurationKey;
  readonly pastDurationKey: DisplayPastDurationKey;
  readonly pastDuration: number;
  readonly tickLabelMode: TickLabelMode;
  readonly showElementTimes: boolean;
  readonly showTicks: boolean;
  readonly duration: number;
  readonly displayTime: number;
  // ランの元期(simTime=0)の unix 秒相当。displayTime を足すと絶対日時になる。
  readonly epochUnixSec: number;
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
  public onShowElementTimesChange: ((show: boolean) => void) | null = null;
  public onShowTicksChange: ((show: boolean) => void) | null = null;
  public onSliderChange: ((t: number) => void) | null = null;
  public onResetToNow: (() => void) | null = null;
  public onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly timelineElapsed: HTMLElement;
  private readonly timelineAbsolute: HTMLElement;
  private readonly timelinePrediction: HTMLElement;
  private readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
  private readonly pastDurationRow: DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>;
  private readonly tickLabelModeSwitch: ToggleSwitch;
  private readonly showTicksSwitch: ToggleSwitch;
  private readonly showElementTimesSwitch: ToggleSwitch;
  private readonly slider: Slider;
  private readonly absoluteLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly jumpToggle: ToggleValueEdit;
  private readonly ticks: HTMLElement;
  private readonly wrap: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  private sliderSteps = 1000;
  private currentDuration = APERIODIC_ARC_DURATION;
  private lastTrackRatio = 1;

  // PREDICT パネルの DOM を組み立て、root へ追加する。collapse は折りたたみトグルの配線役。
  public constructor(root: HTMLElement, collapse: PanelCollapse) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel editorial-instrument';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'editorial-panel-head predict-head';
    head.innerHTML = '<span class="ui-section-code" aria-hidden="true">TML</span><h3 class="editorial-panel-title">ORBIT TIMELINE</h3>';
    this.panel.appendChild(head);

    const state = document.createElement('section');
    state.className = 'predict-state editorial-state';
    state.innerHTML = `
      <div class="editorial-state-hero">
        <span class="ui-data-label">DISPLAY TIME</span>
        <strong data-predict-state="elapsed">T+00:00</strong>
        <span class="ui-annotation" data-predict-state="absolute">—</span>
      </div>
      <div class="predict-state-progress">
        <span class="ui-data-label">PREDICTED</span>
        <span class="ui-data-secondary" data-predict-state="prediction">—</span>
      </div>`;
    this.panel.appendChild(state);
    this.timelineElapsed = state.querySelector<HTMLElement>('[data-predict-state="elapsed"]')!;
    this.timelineAbsolute = state.querySelector<HTMLElement>('[data-predict-state="absolute"]')!;
    this.timelinePrediction = state.querySelector<HTMLElement>('[data-predict-state="prediction"]')!;

    const controls = document.createElement('div');
    controls.className = 'predict-controls editorial-control-zone';
    this.panel.appendChild(controls);

    const durationRows = this.buildDurationRows(controls);
    this.durationRow = durationRows.durationRow;
    this.pastDurationRow = durationRows.pastDurationRow;

    const modeSwitches = this.buildModeRow(controls);
    this.tickLabelModeSwitch = modeSwitches.tickLabelModeSwitch;
    this.showTicksSwitch = modeSwitches.showTicksSwitch;
    this.showElementTimesSwitch = modeSwitches.showElementTimesSwitch;

    const scrubberRow = this.buildScrubberRow(controls);
    this.slider = scrubberRow.slider;
    this.absoluteLabel = scrubberRow.absoluteLabel;
    this.elapsedLabel = scrubberRow.elapsedLabel;
    this.jumpToggle = scrubberRow.jumpToggle;

    // 目盛り。スクラバーの直下に置く。
    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    controls.appendChild(this.ticks);

    // トグルとバー本体を1つの縦積み flex にまとめ、バーを畳んでもトグルだけがその場に残るようにする。
    this.wrap = document.createElement('div');
    this.wrap.id = 'hud-predict-wrap';
    this.wrap.appendChild(this.panel);
    this.unsubscribeCollapsedView = collapse.wire({
      toggleRoot: this.wrap,
      toggleId: 'hud-predict-toggle',
      toggleClassName: '',
      target: this.panel,
      labels: PREDICT_TOGGLE_LABELS,
      storageId: 'hud-predict',
    });
    root.appendChild(this.wrap);
  }

  // 未来と過去、それぞれの期間ピル行を組む。過去は「なし」も選べる。
  private buildDurationRows(container: HTMLElement): {
    readonly durationRow: DurationPillRow<FixedDurationKey, DisplayDurationKey>;
    readonly pastDurationRow: DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>;
  } {
    // 未来の期間。
    const durationRow = new DurationPillRow<FixedDurationKey, DisplayDurationKey>(
      '未来', FIXED_DURATIONS,
      (key) => this.onDurationSelect?.(key),
      (sec) => this.onCustomDurationConfirm?.(sec),
    );
    container.appendChild(durationRow.element);
    // 過去の期間。
    const pastDurationRow = new DurationPillRow<FixedPastDurationKey, DisplayPastDurationKey>(
      '過去', FIXED_PAST_DURATIONS,
      (key) => this.onPastDurationSelect?.(key),
      (sec) => this.onPastCustomDurationConfirm?.(sec),
    );
    pastDurationRow.element.classList.add('predict-past');
    container.appendChild(pastDurationRow.element);
    return { durationRow, pastDurationRow };
  }

  // 目盛りラベルの表記(UTC カレンダー / 現在からの経過時間)、目盛り行そのものの表示有無、
  // 軌道要素の時刻の表示有無を選ぶ行。
  private buildModeRow(container: HTMLElement): {
    readonly tickLabelModeSwitch: ToggleSwitch;
    readonly showTicksSwitch: ToggleSwitch;
    readonly showElementTimesSwitch: ToggleSwitch;
  } {
    const modeRow = document.createElement('div');
    modeRow.className = 'predict-row1';
    const tickLabelModeSwitch = new ToggleSwitch(
      '目盛りを相対表記',
      (on) => this.onTickLabelModeChange?.(on ? 'relative' : 'absolute'),
    );
    modeRow.appendChild(tickLabelModeSwitch.element);
    const showTicksSwitch = new ToggleSwitch(
      '目盛りを表示',
      (on) => this.onShowTicksChange?.(on),
    );
    modeRow.appendChild(showTicksSwitch.element);
    const showElementTimesSwitch = new ToggleSwitch(
      '軌道要素の時刻を表示',
      (on) => this.onShowElementTimesChange?.(on),
    );
    modeRow.appendChild(showElementTimesSwitch.element);
    container.appendChild(modeRow);
    return { tickLabelModeSwitch, showTicksSwitch, showElementTimesSwitch };
  }

  // 現在に戻すボタン + スクラバー + T+読み値(クリックで直接ジャンプ入力に変わる)の行。
  private buildScrubberRow(container: HTMLElement): {
    readonly slider: Slider;
    readonly absoluteLabel: HTMLElement;
    readonly elapsedLabel: HTMLElement;
    readonly jumpToggle: ToggleValueEdit;
  } {
    const row2 = document.createElement('div');
    row2.className = 'predict-row2';
    const resetBtn = new Button('⏮', () => this.onResetToNow?.());
    resetBtn.element.classList.add('predict-reset');
    resetBtn.element.title = '現在に戻す';
    resetBtn.element.setAttribute('aria-label', '現在に戻す');
    row2.appendChild(resetBtn.element);

    // 表示時刻を選ぶスクラバー本体。
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'predict-slider-wrap';
    const slider = new Slider(
      { min: 0, max: this.sliderSteps },
      (value) => this.onSliderChange?.(value / this.sliderSteps),
    );
    slider.element.title = 'ドラッグ、またはトラックをクリックして未来位置を選ぶ';
    sliderWrap.appendChild(slider.element);
    row2.appendChild(sliderWrap);

    const absoluteLabel = document.createElement('span');
    absoluteLabel.className = 'predict-absolute';
    row2.appendChild(absoluteLabel);

    // T+読み値。クリックするとジャンプ入力欄(jumpToggle)へ差し替わる。
    const elapsedLabel = document.createElement('span');
    elapsedLabel.className = 'predict-elapsed';
    elapsedLabel.title = 'クリックして時刻へジャンプ';
    elapsedLabel.addEventListener('pointerdown', (e) => e.stopPropagation());
    elapsedLabel.addEventListener('click', () => this.jumpToggle.open(
      this.currentDuration * (slider.getValue() / this.sliderSteps), 0, this.currentDuration,
    ));
    row2.appendChild(elapsedLabel);

    const jumpEditEl = document.createElement('span');
    jumpEditEl.className = 'predict-value-input hidden';
    const jumpToggle = new ToggleValueEdit(elapsedLabel, jumpEditEl, 'hour', (sec) => this.onJumpToTime?.(sec));
    jumpEditEl.appendChild(jumpToggle.inputEl);
    row2.appendChild(jumpEditEl);
    container.appendChild(row2);

    return { slider, absoluteLabel, elapsedLabel, jumpToggle };
  }

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  public render(state: PredictPanelState): void {
    this.setVisible(state.visible);
    if (!state.visible) return;
    // 期間はジャンプ入力の上限にもなるので控えておく。
    this.currentDuration = state.duration;
    this.durationRow.render(state.durationKey, state.duration);
    this.pastDurationRow.render(state.pastDurationKey, state.pastDuration);
    this.tickLabelModeSwitch.setOn(state.tickLabelMode === 'relative');
    this.showTicksSwitch.setOn(state.showTicks);
    this.showElementTimesSwitch.setOn(state.showElementTimes);
    this.renderSlider(state.sliderSteps, state.sliderT, state.predictionRatio);
    this.renderAbsoluteLabel(state.epochUnixSec + state.displayTime);
    if (!this.jumpToggle.editing) this.renderElapsedLabel(state.sliderT * state.duration);
    const elapsed = state.sliderT * state.duration;
    this.timelineElapsed.textContent = `T+${fmtDuration(elapsed, elapsed)}`;
    this.timelineAbsolute.textContent = fmtDateTime(state.epochUnixSec + state.displayTime);
    this.timelinePrediction.textContent = `${Math.round(state.predictionRatio * 100)}%`;
    this.ticks.classList.toggle('hidden', !state.showTicks);
    this.renderTicks(state.ticks);
  }

  // パネル本体を出し入れする。折りたたみトグルは外側に残る。
  private setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // パネルの DOM を取り除き、折りたたみ状態変化の購読を解除する。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.wrap.remove();
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
  private renderAbsoluteLabel(displayUnixSec: number): void {
    const text = fmtDateTime(displayUnixSec);
    if (this.absoluteLabel.textContent !== text) this.absoluteLabel.textContent = text;
  }

  // T+ 表記の経過時間を表示する。
  private renderElapsedLabel(elapsedSec: number): void {
    const text = `T+${fmtDuration(elapsedSec, elapsedSec)}`;
    if (this.elapsedLabel.textContent !== text) this.elapsedLabel.textContent = text;
  }

  // 各目盛りをスライダー全域上の位置 t(0..1)へ置く。t は期間の等分ではなく、最後の目盛りが
  // 右端に来るとも限らないので、端からはみ出さないための寄せ方も t の値そのものから決める。
  private renderTicks(ticks: readonly DisplayTick[]): void {
    if (this.ticks.childElementCount !== ticks.length) {
      this.ticks.innerHTML = '';
      for (const _tick of ticks) {
        const tick = document.createElement('span');
        this.ticks.appendChild(tick);
      }
    }
    // 本数が変わらない限り要素は使い回し、変わった値だけ書く。
    let i = 0;
    for (const tick of ticks) {
      const el = this.ticks.children[i++];
      if (el === undefined || tick === undefined || !(el instanceof HTMLElement)) continue;
      if (el.textContent !== tick.label) el.textContent = tick.label;
      const left = `${tick.t * 100}%`;
      if (el.style.left !== left) el.style.left = left;
      const transform = tick.t < 0.02 ? 'none' : tick.t > 0.98 ? 'translateX(-100%)' : 'translateX(-50%)';
      if (el.style.transform !== transform) el.style.transform = transform;
    }
  }
}