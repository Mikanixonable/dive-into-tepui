// 未来表示の操作パネル(表示期間・未来ゴーストスライダー・目盛り・手動レンジ入力・ジャンプ入力)。
import { hudButton, SegmentedControl } from './hud/buttons';
import type { DisplayDurationKey } from './display-time-manager';
import { hudDock } from './hud/dom';
import type { DisplayTick } from './hud/tick-scale';

const DURATIONS: readonly (readonly [DisplayDurationKey, string])[] = [
  ['orbit', '1周'],
  ['90min', '90分'],
  ['day', '1日'],
  ['week', '7日'],
  ['month', '28日'],
  ['manual', '手動'],
];

type DurationUnit = 'hour' | 'day' | 'month' | 'year';

const UNIT_SEC: Record<DurationUnit, number> = { hour: 3600, day: 86400, month: 30 * 86400, year: 365 * 86400 };

const UNITS: readonly (readonly [DurationUnit, string])[] = [
  ['hour', '時'],
  ['day', '日'],
  ['month', '月'],
  ['year', '年'],
];

const SLIDER_HINT = 'スライダーで未来位置を確認';

// 値(数値入力)+単位(SegmentedControl)の組。秒数への換算とレンジクランプ・min/max属性の
// 単位追従をここに閉じ込め、手動レンジ入力とジャンプ入力の両方から使う。
class DurationValueInput {
  readonly row: HTMLElement;
  private readonly value: HTMLInputElement;
  private readonly unit: SegmentedControl<DurationUnit>;
  private unitValue: DurationUnit;
  private minSec = 0;
  private maxSec = Infinity;

  // onChange はクランプ後の秒数で呼ばれる。defaultValue は単位換算前の表示値。
  constructor(defaultUnit: DurationUnit, defaultValue: number, onChange: (sec: number) => void) {
    this.unitValue = defaultUnit;
    this.row = document.createElement('div');
    this.row.className = 'hud-seg';
    this.value = document.createElement('input');
    this.value.type = 'number';
    this.value.value = String(defaultValue);
    this.value.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.value.addEventListener('input', () => this.emit(onChange));
    this.row.appendChild(this.value);
    this.unit = new SegmentedControl('単位', UNITS, (unit) => {
      this.unitValue = unit;
      this.unit.setSelected(unit);
      this.syncMinMaxAttr();
      this.emit(onChange);
    });
    this.unit.setSelected(this.unitValue);
    this.row.appendChild(this.unit.element);
  }

  get element(): HTMLElement {
    return this.row;
  }

  // 現在の入力値・単位から秒数をレンジへクランプして通知する。クランプで値が変われば入力欄にも書き戻す。
  private emit(onChange: (sec: number) => void): void {
    const raw = Number(this.value.value);
    const unitSec = UNIT_SEC[this.unitValue];
    const sec = Math.max(this.minSec, Math.min(this.maxSec, (isFinite(raw) ? raw : 0) * unitSec));
    const shown = sec / unitSec;
    if (Number(this.value.value) !== shown) this.value.value = String(shown);
    onChange(sec);
  }

  // 単位換算した min/max を input 要素の属性へ反映する(0 近傍への誤入力を防ぐ)。
  private syncMinMaxAttr(): void {
    const unitSec = UNIT_SEC[this.unitValue];
    this.value.min = String(this.minSec / unitSec);
    if (isFinite(this.maxSec)) this.value.max = String(this.maxSec / unitSec);
    else this.value.removeAttribute('max');
  }

  // 入力が取りうる秒数の範囲を設定する。
  setRange(minSec: number, maxSec: number): void {
    this.minSec = minSec;
    this.maxSec = maxSec;
    this.syncMinMaxAttr();
  }
}

export class DisplayTimePanel {
  onDurationSelect: ((key: DisplayDurationKey) => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;
  onManualDurationChange: ((sec: number) => void) | null = null;
  onResetToNow: (() => void) | null = null;
  onJumpToTime: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly duration: SegmentedControl<DisplayDurationKey>;
  private readonly slider: HTMLInputElement;
  private readonly sliderLabel: HTMLElement;
  private readonly ticks: HTMLElement;
  private readonly manualInput: DurationValueInput;
  private readonly jumpInput: DurationValueInput;
  private sliderSteps = 1000;

  // PREDICT パネルの DOM を組み立て、root へ追加する。
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-displaytime';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'PREDICT';
    this.panel.appendChild(title);

    // 期間選択(1周回/1日/7日/28日/手動)
    this.duration = new SegmentedControl('期間', DURATIONS, (key) => this.onDurationSelect?.(key));
    this.panel.appendChild(this.duration.element);

    // 手動レンジ入力。'manual' 選択時のみ表示する。
    this.manualInput = new DurationValueInput('day', 1, (sec) => this.onManualDurationChange?.(sec));
    this.panel.appendChild(this.manualInput.element);

    // T+時刻への直接ジャンプ入力。
    this.jumpInput = new DurationValueInput('hour', 0, (sec) => this.onJumpToTime?.(sec));
    this.panel.appendChild(this.jumpInput.element);

    // 未来ゴーストスライダー
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = String(this.sliderSteps);
    this.slider.value = '0';
    this.slider.addEventListener('input', () => this.onSliderChange?.(Number(this.slider.value) / this.sliderSteps));
    this.panel.appendChild(this.slider);

    this.panel.appendChild(hudButton('現在に戻す', () => this.onResetToNow?.()));

    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    this.panel.appendChild(this.ticks);

    this.sliderLabel = document.createElement('div');
    this.sliderLabel.className = 'slider-label';
    this.sliderLabel.textContent = SLIDER_HINT;
    this.panel.appendChild(this.sliderLabel);

    hudDock(root, 'left').appendChild(this.panel);
  }

  // パネル全体の表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // 期間選択の選択状態を key に合わせる。
  setDuration(key: DisplayDurationKey): void {
    this.duration.setSelected(key);
  }

  // 手動レンジ入力行の表示/非表示を切り替える('manual' 選択時のみ表示)。
  setManualVisible(visible: boolean): void {
    this.manualInput.element.style.display = visible ? 'flex' : 'none';
  }

  // スライダーが未来時刻を指している間はその時刻のラベル、原点にある間は操作案内。
  setSliderLabel(label: string | null): void {
    const text = label ?? SLIDER_HINT;
    if (this.sliderLabel.textContent !== text) this.sliderLabel.textContent = text;
  }

  // スライダーの段階数を設定する。現在のつまみ位置(0..1 換算)は維持する。
  setSliderSteps(steps: number): void {
    if (steps === this.sliderSteps) return;
    const t = Number(this.slider.value) / this.sliderSteps;
    this.sliderSteps = steps;
    this.slider.max = String(steps);
    this.slider.value = String(Math.round(t * steps));
  }

  // スライダーのつまみ位置を t(0..1)に合わせる。
  setSliderValue(t: number): void {
    const value = String(Math.round(t * this.sliderSteps));
    if (this.slider.value !== value) this.slider.value = value;
  }

  // 手動レンジ入力・ジャンプ入力が取りうる秒数の範囲を設定する。
  setManualRange(minSec: number, maxSec: number): void {
    this.manualInput.setRange(minSec, maxSec);
    this.jumpInput.setRange(0, maxSec);
  }

  // 各目盛りをスライダー全域上の位置 t(0..1)に配置する。
  setTicks(ticks: readonly DisplayTick[]): void {
    if (this.ticks.childElementCount !== ticks.length) {
      this.ticks.innerHTML = '';
      for (let i = 0; i < ticks.length; i++) {
        const tick = document.createElement('span');
        this.ticks.appendChild(tick);
      }
    }
    for (let i = 0; i < ticks.length; i++) {
      const el = this.ticks.children[i];
      const tick = ticks[i];
      if (el === undefined || tick === undefined || !(el instanceof HTMLElement)) continue;
      if (el.textContent !== tick.label) el.textContent = tick.label;
      const left = `${tick.t * 100}%`;
      if (el.style.left !== left) el.style.left = left;
    }
  }
}
