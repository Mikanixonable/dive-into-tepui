// 予測表示の操作パネル(表示期間・予測軌道の表示座標系・未来位置スライダー)。PredictSystem が
// 所有し、映すのも受けるのも predict 自身の状態だけに閉じる。
// CSS(#hud-predict)は hud/dom.ts の STYLE に一元管理されている。
import { Frame } from '../../physics/frame';
import { SegmentedControl } from '../hud/buttons';
import type { PredictDurationKey } from './predict-system';

const DURATIONS: readonly (readonly [PredictDurationKey, string])[] = [
  ['orbit', '1周回'],
  ['day', '1日'],
  ['week', '7日'],
  ['month', '28日'],
];

const FRAMES: readonly (readonly [Frame, string])[] = [
  ['inertial', '慣性系'],
  ['sunRotating', '太陽回転系'],
];

const SLIDER_HINT = 'スライダーで未来位置を確認';

export class PredictPanel {
  onDurationSelect: ((key: PredictDurationKey) => void) | null = null;
  onFrameSelect: ((frame: Frame) => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly duration: SegmentedControl<PredictDurationKey>;
  private readonly frame: SegmentedControl<Frame>;
  private readonly slider: HTMLInputElement;
  private readonly sliderLabel: HTMLElement;

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-predict';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'PREDICT';
    this.panel.appendChild(title);

    this.duration = new SegmentedControl('期間', DURATIONS, (key) => this.onDurationSelect?.(key));
    this.frame = new SegmentedControl('軌道', FRAMES, (frame) => this.onFrameSelect?.(frame));
    this.panel.appendChild(this.duration.element);
    this.panel.appendChild(this.frame.element);

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

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  setDuration(key: PredictDurationKey): void {
    this.duration.setSelected(key);
  }

  setFrame(frame: Frame): void {
    this.frame.setSelected(frame);
  }

  // スライダーが未来時刻を指している間はその時刻のラベル(T+ 表記・高度)、原点にある間は操作案内。
  setSliderLabel(label: string | null): void {
    const text = label ?? SLIDER_HINT;
    if (this.sliderLabel.textContent !== text) this.sliderLabel.textContent = text;
  }
}
