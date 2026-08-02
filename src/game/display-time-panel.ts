// 未来表示の操作パネル(表示期間・未来ゴーストスライダー・目盛り・手動レンジ入力)。
import { SegmentedControl } from './hud/buttons';
import type { DisplayDurationKey } from './display-time-manager';

const DURATIONS: readonly (readonly [DisplayDurationKey, string])[] = [
  ['orbit', '1周回'],
  ['day', '1日'],
  ['week', '7日'],
  ['month', '28日'],
  ['manual', '手動'],
];

type DurationUnit = 'hour' | 'day' | 'week' | 'year';

const UNIT_SEC: Record<DurationUnit, number> = { hour: 3600, day: 86400, week: 7 * 86400, year: 365 * 86400 };

const UNITS: readonly (readonly [DurationUnit, string])[] = [
  ['hour', '時'],
  ['day', '日'],
  ['week', '週'],
  ['year', '年'],
];

const SLIDER_HINT = 'スライダーで未来位置を確認';

export class DisplayTimePanel {
  onDurationSelect: ((key: DisplayDurationKey) => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;
  onManualDurationChange: ((sec: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly duration: SegmentedControl<DisplayDurationKey>;
  private readonly slider: HTMLInputElement;
  private readonly sliderLabel: HTMLElement;
  private readonly ticks: HTMLElement;
  private readonly manualRow: HTMLElement;
  private readonly manualValue: HTMLInputElement;
  private readonly manualUnit: SegmentedControl<DurationUnit>;
  private manualUnitValue: DurationUnit = 'day';

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

    // 手動レンジ入力: 値 + 単位。'manual' 選択時のみ表示する。
    this.manualRow = document.createElement('div');
    this.manualRow.className = 'hud-seg';
    this.manualValue = document.createElement('input');
    this.manualValue.type = 'number';
    this.manualValue.min = '0';
    this.manualValue.value = '1';
    this.manualValue.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.manualValue.addEventListener('input', () => this.emitManualDuration());
    this.manualRow.appendChild(this.manualValue);
    this.manualUnit = new SegmentedControl('単位', UNITS, (unit) => {
      this.manualUnitValue = unit;
      this.manualUnit.setSelected(unit);
      this.emitManualDuration();
    });
    this.manualUnit.setSelected(this.manualUnitValue);
    this.manualRow.appendChild(this.manualUnit.element);
    this.panel.appendChild(this.manualRow);

    // 未来ゴーストスライダー
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = '1000';
    this.slider.value = '0';
    this.slider.addEventListener('input', () => this.onSliderChange?.(Number(this.slider.value) / 1000));
    this.panel.appendChild(this.slider);

    this.ticks = document.createElement('div');
    this.ticks.className = 'slider-ticks';
    this.panel.appendChild(this.ticks);

    this.sliderLabel = document.createElement('div');
    this.sliderLabel.className = 'slider-label';
    this.sliderLabel.textContent = SLIDER_HINT;
    this.panel.appendChild(this.sliderLabel);

    root.appendChild(this.panel);
  }

  // 現在の入力値・単位から秒数を計算して通知する。
  private emitManualDuration(): void {
    const value = Number(this.manualValue.value);
    if (!isFinite(value) || value < 0) return;
    this.onManualDurationChange?.(value * UNIT_SEC[this.manualUnitValue]);
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
    this.manualRow.style.display = visible ? 'flex' : 'none';
  }

  // スライダーが未来時刻を指している間はその時刻のラベル(T+ 表記)、原点にある間は操作案内。
  setSliderLabel(label: string | null): void {
    const text = label ?? SLIDER_HINT;
    if (this.sliderLabel.textContent !== text) this.sliderLabel.textContent = text;
  }

  // スライダー全域を等分した各点のラベルを目盛りとして並べる。
  setTicks(labels: readonly string[]): void {
    if (this.ticks.childElementCount !== labels.length) {
      this.ticks.innerHTML = '';
      for (let i = 0; i < labels.length; i++) {
        const tick = document.createElement('span');
        this.ticks.appendChild(tick);
      }
    }
    for (let i = 0; i < labels.length; i++) {
      const tick = this.ticks.children[i];
      const label = labels[i];
      if (tick !== undefined && label !== undefined && tick.textContent !== label) tick.textContent = label;
    }
  }
}
