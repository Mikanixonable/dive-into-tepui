// 未来表示の操作パネル(期間ピル・スクラバー・目盛り)。3行構成: 期間選択 / スクラブバー+T+読み値 / 目盛り。
import * as C from './const';
import { hudButton, SegmentedControl } from './hud/buttons';
import { buildCollapseToggle, PREDICT_TOGGLE_LABELS } from './hud/dom';
import { SIM_EPOCH_SEC, fmtDateTime, fmtDuration } from './hud/utils';
import type { DisplayDurationKey } from './display-window-manager';
import type { DisplayTick } from './hud/tick-scale';
import { FILL_2, FILL_4 } from './theme';

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

const TRACK_COLOR = FILL_4;
const TRACK_DIM_COLOR = FILL_2;

// 値(数値入力)+単位(SegmentedControl)の組。確定操作(Enter/blur/外部からの commit())でのみ
// クランプ後の秒数を通知する — 打鍵ごとに書き戻すと入力途中の値が壊れて打ち直せなくなるため。
// 空欄・非数値での確定、または Escape/cancel() は「変更なし」として現在の表示へ戻す。
class DurationValueInput {
  readonly element: HTMLElement;
  private readonly value: HTMLInputElement;
  private readonly unit: SegmentedControl<DurationUnit>;
  private unitValue: DurationUnit;
  private minSec = 0;
  private maxSec = Infinity;
  private suppressBlurCommit = false;

  // onCommit は Enter・blur・確定ボタンでのみ呼ばれる — 呼び出し側は打鍵ごとの値を追う必要がない。
  constructor(defaultUnit: DurationUnit, private readonly onCommit: (sec: number) => void, private readonly onCancel: () => void) {
    this.unitValue = defaultUnit;
    this.element = document.createElement('span');
    this.element.className = 'hud-seg dtp-value-input';
    // 単位ボタンを押しても数値欄からフォーカスを移さない — 移すと blur が確定として走り、
    // 選び直した単位が反映される前に古い単位の値で閉じてしまう。フォーカス移動の既定動作を
    // 持つのは mousedown なので、それを捕捉段階で止める。
    this.element.addEventListener('mousedown', (e) => {
      if (e.target !== this.value) e.preventDefault();
    }, true);
    // 数値入力欄。Enter/Escape は自前でハンドリングし、それ以外のフォーカス喪失は commit 扱いにする。
    this.value = document.createElement('input');
    this.value.type = 'number';
    this.value.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.value.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
    });
    this.value.addEventListener('blur', () => {
      if (this.suppressBlurCommit) { this.suppressBlurCommit = false; return; }
      this.commit();
    });
    this.element.appendChild(this.value);
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
    this.suppressBlurCommit = false;
    this.minSec = minSec;
    this.maxSec = maxSec;
    this.syncMinMaxAttr();
    this.value.value = String(sec / UNIT_SEC[this.unitValue]);
    this.value.focus();
    this.value.select();
  }

  // 入力中の値をレンジへクランプして通知する。空欄・非数値なら変更なしとして cancel() する。
  // onCommit が呼び出し元の要素を隠す(display:none)と暗黙の blur が同期的に起きるので、
  // それが二重に commit() を呼ばないよう先に抑制フラグを立てる。
  commit(): void {
    const text = this.value.value.trim();
    const raw = Number(text);
    if (text === '' || !isFinite(raw)) { this.cancel(); return; }
    const unitSec = UNIT_SEC[this.unitValue];
    const sec = Math.max(this.minSec, Math.min(this.maxSec, raw * unitSec));
    this.value.value = String(sec / unitSec);
    this.suppressBlurCommit = true;
    this.onCommit(sec);
  }

  // 編集を破棄する。blur によるフォーカス移動が重ねて commit() を呼ばないよう先に抑制する。
  cancel(): void {
    this.suppressBlurCommit = true;
    this.value.blur();
    this.onCancel();
  }

  // 入力欄の min/max 属性を現在の単位での表示値に換算して合わせる。
  private syncMinMaxAttr(): void {
    const unitSec = UNIT_SEC[this.unitValue];
    this.value.min = String(this.minSec / unitSec);
    if (isFinite(this.maxSec)) this.value.max = String(this.maxSec / unitSec);
    else this.value.removeAttribute('max');
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
  btn.className = 'dtp-edit-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  btn.addEventListener('click', () => onClick());
  return btn;
}

export interface DisplayTimePanelState {
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

export class DisplayTimePanel {
  onDurationSelect: ((key: FixedDurationKey) => void) | null = null;
  onCustomDurationConfirm: ((sec: number) => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;
  onResetToNow: (() => void) | null = null;
  onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly durationPillsEl: HTMLElement;
  private readonly durationButtons = new Map<FixedDurationKey, HTMLElement>();
  private readonly customPillBtn: HTMLElement;
  private readonly durationEditEl: HTMLElement;
  private readonly durationInput: DurationValueInput;
  private readonly slider: HTMLInputElement;
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
    this.panel.id = 'hud-displaytime';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'PREDICT';
    this.panel.appendChild(title);

    // 行1: 期間ピル(1周/1日/7日/28日/任意…)。任意…は自身をインライン編集フォームへ差し替える。
    const row1 = document.createElement('div');
    row1.className = 'dtp-row1';
    const durationLabel = document.createElement('span');
    durationLabel.className = 'seg-title';
    durationLabel.textContent = '期間';
    row1.appendChild(durationLabel);

    this.durationPillsEl = document.createElement('span');
    this.durationPillsEl.className = 'dtp-pills';
    for (const [key, label] of FIXED_DURATIONS) {
      const btn = hudButton(label, () => this.onDurationSelect?.(key));
      this.durationPillsEl.appendChild(btn);
      this.durationButtons.set(key, btn);
    }
    this.customPillBtn = hudButton('任意…', () => this.openDurationEdit());
    this.durationPillsEl.appendChild(this.customPillBtn);
    row1.appendChild(this.durationPillsEl);

    this.durationInput = new DurationValueInput(
      'day',
      (sec) => { this.onCustomDurationConfirm?.(sec); this.closeDurationEdit(); },
      () => this.closeDurationEdit(),
    );
    this.durationEditEl = document.createElement('span');
    this.durationEditEl.className = 'dtp-pills';
    this.durationEditEl.style.display = 'none';
    this.durationEditEl.appendChild(this.durationInput.element);
    this.durationEditEl.appendChild(inlineIconButton('✓', '確定', () => this.durationInput.commit()));
    this.durationEditEl.appendChild(inlineIconButton('✕', 'キャンセル', () => this.durationInput.cancel()));
    row1.appendChild(this.durationEditEl);
    this.panel.appendChild(row1);

    // 行2: 現在に戻すボタン + スクラバー + T+読み値(クリックで直接ジャンプ入力に変わる)。
    const row2 = document.createElement('div');
    row2.className = 'dtp-row2';
    const resetBtn = document.createElement('span');
    resetBtn.className = 'dtp-reset';
    resetBtn.textContent = '⏮';
    resetBtn.title = '現在に戻す';
    resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', () => this.onResetToNow?.());
    row2.appendChild(resetBtn);

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'dtp-slider-wrap';
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = String(this.sliderSteps);
    this.slider.value = '0';
    this.slider.title = 'ドラッグ、またはトラックをクリックして未来位置を選ぶ';
    this.slider.addEventListener('input', () => this.onSliderChange?.(Number(this.slider.value) / this.sliderSteps));
    sliderWrap.appendChild(this.slider);
    row2.appendChild(sliderWrap);

    this.absoluteLabel = document.createElement('span');
    this.absoluteLabel.className = 'dtp-absolute';
    row2.appendChild(this.absoluteLabel);

    this.elapsedLabel = document.createElement('span');
    this.elapsedLabel.className = 'dtp-elapsed';
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
    this.jumpEditEl.className = 'dtp-value-input';
    this.jumpEditEl.style.display = 'none';
    this.jumpEditEl.appendChild(this.jumpInput.element);
    row2.appendChild(this.jumpEditEl);
    this.panel.appendChild(row2);

    // 行3: 目盛り。スクラバーの直下に置く。
    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    this.panel.appendChild(this.ticks);

    // トグルとバー本体を1つの縦積み flex にまとめ、バーを畳んでもトグルだけがその場に残るようにする。
    const wrap = document.createElement('div');
    wrap.id = 'hud-displaytime-wrap';
    wrap.appendChild(this.panel);
    buildCollapseToggle(wrap, 'hud-displaytime-toggle', '', this.panel, PREDICT_TOGGLE_LABELS);
    root.appendChild(wrap);
  }

  // state をパネルへ反映する。編集中の行はユーザー入力を壊さないよう再描画しない。
  render(state: DisplayTimePanelState): void {
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
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // 選択中の期間キーに応じてピルの選択表示を更新する。'custom' のときは任意ピルへ現在値を出す。
  private renderDurationPills(key: DisplayDurationKey, customDurationSec: number): void {
    for (const [k, btn] of this.durationButtons) btn.classList.toggle('on', k === key);
    this.customPillBtn.classList.toggle('on', key === 'custom');
    const customLabel = key === 'custom' ? `${customPillLabel(customDurationSec)} ✎` : '任意…';
    if (this.customPillBtn.textContent !== customLabel) this.customPillBtn.textContent = customLabel;
  }

  // 期間ピル列を数値入力フォームへ差し替える。
  private openDurationEdit(): void {
    this.editingDuration = true;
    this.durationPillsEl.style.display = 'none';
    this.durationEditEl.style.display = 'inline-flex';
    this.durationInput.openWithSec(this.currentDuration, C.DISPLAY_DURATION_MIN, C.DISPLAY_DURATION_MAX);
  }

  // 数値入力フォームを閉じ、期間ピル列を出す。
  private closeDurationEdit(): void {
    this.editingDuration = false;
    this.durationEditEl.style.display = 'none';
    this.durationPillsEl.style.display = '';
  }

  // スライダーの段階数・つまみ位置・未予測区間の表示を反映する。
  private renderSlider(steps: number, t: number, predictionRatio: number): void {
    if (steps !== this.sliderSteps) {
      this.sliderSteps = steps;
      this.slider.max = String(steps);
    }
    const value = String(Math.round(t * this.sliderSteps));
    if (this.slider.value !== value) this.slider.value = value;
    if (predictionRatio !== this.lastTrackRatio) {
      this.lastTrackRatio = predictionRatio;
      // <input type=range> はトラック上の区間ごとに色を分けられないので、
      // 背景グラデーションで未予測区間の減光を表す。
      this.slider.style.background = predictionRatio >= 1
        ? ''
        : `linear-gradient(to right, ${TRACK_COLOR} 0%, ${TRACK_COLOR} ${predictionRatio * 100}%, ${TRACK_DIM_COLOR} ${predictionRatio * 100}%, ${TRACK_DIM_COLOR} 100%)`;
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
    this.elapsedLabel.style.display = 'none';
    this.jumpEditEl.style.display = 'inline-flex';
    this.jumpInput.openWithSec(this.currentDuration * (Number(this.slider.value) / this.sliderSteps), 0, this.currentDuration);
  }

  // 数値入力フォームを閉じ、T+ 読み値を出す。
  private closeJumpEdit(): void {
    this.editingJump = false;
    this.jumpEditEl.style.display = 'none';
    this.elapsedLabel.style.display = '';
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
