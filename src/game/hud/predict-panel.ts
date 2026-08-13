// 未来表示の操作パネル(期間ピル・スクラバー・目盛り)。3行構成: 期間選択 / スクラブバー+T+読み値 / 目盛り。
import * as C from '../const';
import { Button, SegmentedControl, Slider, ValueInput } from './widgets';
import { buildCollapseToggle, PREDICT_TOGGLE_LABELS } from './hud-root';
import { SIM_EPOCH_SEC, fmtDateTime, fmtDuration } from './utils';
import type { DisplayDurationKey } from '../display-window-manager';
import type { DisplayTick } from './tick-scale';

type FixedDurationKey = 'orbit' | 'day' | 'week' | 'month';

const FIXED_DURATIONS: readonly (readonly [FixedDurationKey, string])[] = [
  ['orbit', '1周'],
  ['day', '1日'],
  ['week', '7日'],
  ['month', '28日'],
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
  readonly element: HTMLElement;
  private readonly value: ValueInput;
  private readonly unit: SegmentedControl<DurationUnit>;
  private unitValue: DurationUnit;
  private minSec = 0;
  private maxSec = Infinity;

  // onCommit は Enter・blur・確定ボタンでのみ呼ばれる — 呼び出し側は打鍵ごとの値を追う必要がない。
  constructor(defaultUnit: DurationUnit, private readonly onCommit: (sec: number) => void, private readonly onCancel: () => void) {
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
  openWithSec(sec: number, minSec: number, maxSec: number): void {
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

  commit(): void {
    this.value.commit();
  }

  // 編集を破棄する。
  cancel(): void {
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
// 単位は UNITS と同じ和字にし、割り切れる中で最も大きい単位を選ぶ。
function customPillLabel(sec: number): string {
  for (let i = UNITS.length - 1; i > 0; i--) {
    const unit = UNITS[i];
    if (unit === undefined) continue;
    const unitSec = UNIT_SEC[unit[0]];
    if (sec >= unitSec && sec % unitSec === 0) return `${sec / unitSec}${unit[1]}`;
  }
  return `${Math.round(sec / UNIT_SEC.hour)}時`;
}

// フォーカス移動による commit() の割り込みを避けつつ押せる小ボタン(✓/✕ など)。
function inlineIconButton(label: string, title: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('span');
  btn.className = 'predict-edit-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  btn.addEventListener('click', () => onClick());
  return btn;
}

export interface PredictPanelState {
  readonly visible: boolean;
  readonly durationKey: DisplayDurationKey;
  readonly customDurationSec: number;
  readonly duration: number;
  readonly displayTime: number;
  readonly sliderSteps: number;
  readonly sliderT: number;
  readonly predictionRatio: number;
  readonly ticks: readonly DisplayTick[];
}

export class PredictPanel {
  onDurationSelect: ((key: FixedDurationKey) => void) | null = null;
  onCustomDurationConfirm: ((sec: number) => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;
  onResetToNow: (() => void) | null = null;
  onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly durationPillsEl: HTMLElement;
  private readonly durationButtons = new Map<FixedDurationKey, Button>();
  private readonly customPillBtn: Button;
  private readonly durationEditEl: HTMLElement;
  private readonly durationInput: DurationValueInput;
  private readonly slider: Slider;
  private readonly absoluteLabel: HTMLElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly jumpEditEl: HTMLElement;
  private readonly jumpInput: DurationValueInput;
  private readonly ticks: HTMLElement;

  private editingDuration = false;
  private editingJump = false;
  private sliderSteps = 1000;
  private currentDuration = C.APERIODIC_ARC_DURATION;
  private lastTrackRatio = 1;

  // PREDICT パネルの DOM を組み立て、root へ追加する。
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'PREDICT';
    this.panel.appendChild(title);

    // 行1: 期間ピル(1周/1日/7日/28日/任意…)。任意…は自身をインライン編集フォームへ差し替える。
    const row1 = document.createElement('div');
    row1.className = 'predict-row1';
    const durationLabel = document.createElement('span');
    durationLabel.className = 'w-group-title';
    durationLabel.textContent = '期間';
    row1.appendChild(durationLabel);

    this.durationPillsEl = document.createElement('span');
    this.durationPillsEl.className = 'predict-pills';
    for (const [key, label] of FIXED_DURATIONS) {
      const btn = new Button(label, () => this.onDurationSelect?.(key));
      this.durationPillsEl.appendChild(btn.element);
      this.durationButtons.set(key, btn);
    }
    this.customPillBtn = new Button('任意…', () => this.openDurationEdit());
    this.durationPillsEl.appendChild(this.customPillBtn.element);
    row1.appendChild(this.durationPillsEl);

    this.durationInput = new DurationValueInput(
      'day',
      (sec) => { this.onCustomDurationConfirm?.(sec); this.closeDurationEdit(); },
      () => this.closeDurationEdit(),
    );
    this.durationEditEl = document.createElement('span');
    this.durationEditEl.className = 'predict-pills hidden';
    this.durationEditEl.appendChild(this.durationInput.element);
    this.durationEditEl.appendChild(inlineIconButton('✓', '確定', () => this.durationInput.commit()));
    this.durationEditEl.appendChild(inlineIconButton('✕', 'キャンセル', () => this.durationInput.cancel()));
    row1.appendChild(this.durationEditEl);
    this.panel.appendChild(row1);

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
    this.panel.appendChild(row2);

    // 行3: 目盛り。スクラバーの直下に置く。
    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    this.panel.appendChild(this.ticks);

    // トグルとバー本体を1つの縦積み flex にまとめ、バーを畳んでもトグルだけがその場に残るようにする。
    const wrap = document.createElement('div');
    wrap.id = 'hud-predict-wrap';
    wrap.appendChild(this.panel);
    buildCollapseToggle(wrap, 'hud-predict-toggle', '', this.panel, PREDICT_TOGGLE_LABELS);
    root.appendChild(wrap);
  }

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  render(state: PredictPanelState): void {
    this.setVisible(state.visible);
    if (!state.visible) return;
    this.currentDuration = state.duration;
    if (!this.editingDuration) this.renderDurationPills(state.durationKey, state.customDurationSec);
    this.renderSlider(state.sliderSteps, state.sliderT, state.predictionRatio);
    this.renderAbsoluteLabel(state.displayTime);
    if (!this.editingJump) this.renderElapsedLabel(state.sliderT * state.duration);
    this.renderTicks(state.ticks);
  }

  private setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // 選択中の期間キーに応じてピルの選択表示を更新する。'custom' のときは任意ピルへ現在値を出す。
  private renderDurationPills(key: DisplayDurationKey, customDurationSec: number): void {
    for (const [k, btn] of this.durationButtons) btn.setOn(k === key);
    this.customPillBtn.setOn(key === 'custom');
    const customLabel = key === 'custom' ? `${customPillLabel(customDurationSec)} ✎` : '任意…';
    if (this.customPillBtn.element.textContent !== customLabel) this.customPillBtn.setLabel(customLabel);
  }

  // 期間ピル列を数値入力フォームへ差し替える。
  private openDurationEdit(): void {
    this.editingDuration = true;
    this.durationPillsEl.classList.add('hidden');
    this.durationEditEl.classList.remove('hidden');
    this.durationInput.openWithSec(this.currentDuration, C.DISPLAY_DURATION_MIN, C.DISPLAY_DURATION_MAX);
  }

  // 数値入力フォームを閉じ、期間ピル列を出す。
  private closeDurationEdit(): void {
    this.editingDuration = false;
    this.durationEditEl.classList.add('hidden');
    this.durationPillsEl.classList.remove('hidden');
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
    this.editingJump = true;
    this.elapsedLabel.classList.add('hidden');
    this.jumpEditEl.classList.remove('hidden');
    this.jumpInput.openWithSec(this.currentDuration * (this.slider.getValue() / this.sliderSteps), 0, this.currentDuration);
  }

  // 数値入力フォームを閉じ、T+ 読み値を出す。
  private closeJumpEdit(): void {
    this.editingJump = false;
    this.jumpEditEl.classList.add('hidden');
    this.elapsedLabel.classList.remove('hidden');
  }

  // 各目盛りをスライダー全域上の位置 t(0..1)に配置する。端に近い目盛りは画面外へはみ出さないよう
  // 寄せ方を変える(:first-child/:last-child ではなく t の値そのものから決める — 最終目盛りが
  // 常に 100% 位置とは限らないため)。
  // 各目盛りをスライダー全域上の位置 t(0..1)へ置く。t は期間の等分ではなく、最後の目盛りが
  // 右端に来るとも限らないので、端からはみ出さないための寄せ方も t の値そのものから決める。
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
