// つまみ型の連続値スライダー(<input type="range"> の唯一の実装)。動くたびに onInput が
// 呼ばれる — commit ではなく、ドラッグ位置をそのまま反映する用途(スクラブバー・数値入力の
// 補助)のための即時通知。
import { expandHitTarget, stopDragPropagation } from './widget-base';

export interface SliderOptions {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

export class Slider {
  readonly element: HTMLInputElement;

  constructor(options: SliderOptions, onInput: (value: number) => void) {
    this.element = document.createElement('input');
    this.element.type = 'range';
    this.element.className = 'w-slider';
    this.element.min = String(options.min);
    this.element.max = String(options.max);
    if (options.step !== undefined) this.element.step = String(options.step);
    stopDragPropagation(this.element);
    expandHitTarget(this.element);
    // Input の window keydown 購読へ矢印キー等が漏れてゲーム操作と誤認されないよう止める。
    this.element.addEventListener('keydown', (e) => e.stopPropagation());
    this.element.addEventListener('input', () => onInput(Number(this.element.value)));
  }

  setValue(value: number): void {
    this.element.value = String(value);
  }

  getValue(): number {
    return Number(this.element.value);
  }

  // ratio(0..1)まで満ちたグラデーションをトラック背景に描く。1 以上なら単色トラックへ戻す。
  setGradient(ratio: number): void {
    if (ratio >= 1) {
      this.element.style.background = '';
      return;
    }
    const r = Math.max(0, ratio) * 100;
    this.element.style.background =
      `linear-gradient(to right, var(--fill-4) 0%, var(--fill-4) ${r}%, var(--fill-2) ${r}%, var(--fill-2) 100%)`;
  }

  // [minRatio, maxRatio](0..1)の区間だけ通常色にし、区間外は減光したトラック背景を描く。
  // 全域が有効/無効なら単色トラックへ戻す。
  setValidRange(minRatio: number, maxRatio: number): void {
    const lo = Math.max(0, minRatio) * 100;
    const hi = Math.min(1, maxRatio) * 100;
    if (lo <= 0 && hi >= 100) {
      this.element.style.background = '';
    } else if (lo >= hi) {
      this.element.style.background = 'var(--fill-2)';
    } else {
      this.element.style.background =
        `linear-gradient(to right, var(--fill-2) 0%, var(--fill-2) ${lo}%, var(--fill-4) ${lo}%, var(--fill-4) ${hi}%, var(--fill-2) ${hi}%, var(--fill-2) 100%)`;
    }
  }
}
