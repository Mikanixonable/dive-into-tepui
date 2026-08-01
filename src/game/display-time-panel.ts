// 未来表示の操作パネル(表示期間・未来ゴーストスライダー)。
import { SegmentedControl } from './hud/buttons';
import type { DisplayDurationKey } from './display-time-manager';

const DURATIONS: readonly (readonly [DisplayDurationKey, string])[] = [
  ['orbit', '1周回'],
  ['day', '1日'],
  ['week', '7日'],
  ['month', '28日'],
];

const SLIDER_HINT = 'スライダーで未来位置を確認';

export class DisplayTimePanel {
  onDurationSelect: ((key: DisplayDurationKey) => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly duration: SegmentedControl<DisplayDurationKey>;
  private readonly slider: HTMLInputElement;
  private readonly sliderLabel: HTMLElement;

  // PREDICT パネルの DOM を組み立て、root へ追加する。
  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-displaytime';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'PREDICT';
    this.panel.appendChild(title);

    // 期間選択(1周回/1日/7日/28日)
    this.duration = new SegmentedControl('期間', DURATIONS, (key) => this.onDurationSelect?.(key));
    this.panel.appendChild(this.duration.element);

    // 未来ゴーストスライダー
    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = '1000';
    this.slider.value = '0';
    this.slider.addEventListener('input', () => this.onSliderChange?.(Number(this.slider.value) / 1000));
    this.panel.appendChild(this.slider);

    this.sliderLabel = document.createElement('div');
    this.sliderLabel.className = 'slider-label';
    this.sliderLabel.textContent = SLIDER_HINT;
    this.panel.appendChild(this.sliderLabel);

    root.appendChild(this.panel);
  }

  // パネル全体の表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // 期間選択の選択状態を key に合わせる。
  setDuration(key: DisplayDurationKey): void {
    this.duration.setSelected(key);
  }

  // スライダーが未来時刻を指している間はその時刻のラベル(T+ 表記)、原点にある間は操作案内。
  setSliderLabel(label: string | null): void {
    const text = label ?? SLIDER_HINT;
    if (this.sliderLabel.textContent !== text) this.sliderLabel.textContent = text;
  }
}
