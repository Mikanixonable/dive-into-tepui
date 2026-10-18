// つまみ型の連続値スライダー(<input type="range"> の唯一の実装)。動くたびに onInput が
// 呼ばれる — commit ではなく、ドラッグ位置をそのまま反映する用途(スクラブバー・数値入力の
// 補助)のための即時通知。
// 帯と目盛りを載せるトラック(marked)は、入力欄を枠(frame)で包み、トラックの上に目盛りの層を
// 重ねる。つまみは細い線(再生ヘッド)として描き、トラック上のどこを押しても動く。
import { expandHitTarget, stopDragPropagation } from './widget-base';

export interface SliderOptions {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  // 帯と目盛りを載せるトラックにするか。真なら frame が入力欄を包む枠になる。
  readonly marked?: boolean;
}

// 区間の濃淡。quiet は通り過ぎた区間、normal は有効な区間、dim は届いていない区間。
export type SliderBandTone = 'quiet' | 'normal' | 'dim';

// 帯は直前の帯の終端から to までの区間を tone で塗る。to は 0..1(トラック全幅に対する位置)。
export interface SliderBand {
  readonly to: number;
  readonly tone: SliderBandTone;
}

export type SliderMarkTone = 'neutral' | 'own' | 'target';

// トラック上の目盛り。at は 0..1(トラック全幅に対する位置)。
export interface SliderMark {
  readonly at: number;
  readonly glyph: string;
  readonly tone: SliderMarkTone;
  readonly title: string;
}

const BAND_FILL: Readonly<Record<SliderBandTone, string>> = {
  quiet: 'var(--fill-1)',
  normal: 'var(--fill-3)',
  dim: 'transparent',
};

export class Slider {
  public readonly element: HTMLInputElement;
  // DOM へ足すときの最外要素。marked でなければ element そのもの。
  public readonly frame: HTMLElement;
  private readonly markLayer: HTMLElement | null;
  private onMarkSelect: ((index: number) => void) | null = null;

  // options は値域と刻み幅。onInput はドラッグ・矢印キーなど値が動くたびに呼ばれる。
  public constructor(options: SliderOptions, onInput: (value: number) => void) {
    this.element = document.createElement('input');
    this.element.type = 'range';
    this.element.className = 'w-slider';
    this.element.min = String(options.min);
    this.element.max = String(options.max);
    if (options.step !== undefined) this.element.step = String(options.step);
    stopDragPropagation(this.element);
    expandHitTarget(this.element);
    // 矢印キー等の打鍵をゲーム操作と誤認されないよう伝播を止める。
    this.element.addEventListener('keydown', (e) => e.stopPropagation());
    this.element.addEventListener('input', () => onInput(Number(this.element.value)));
    if (options.marked === true) {
      this.frame = document.createElement('div');
      this.frame.className = 'w-slider-frame';
      this.element.classList.add('is-marked');
      this.markLayer = document.createElement('div');
      this.markLayer.className = 'w-slider-marks';
      this.frame.append(this.element, this.markLayer);
    } else {
      this.frame = this.element;
      this.markLayer = null;
    }
  }

  public setValue(value: number): void {
    this.element.value = String(value);
  }

  public getValue(): number {
    return Number(this.element.value);
  }

  // 値域を差し替える。つまみの位置は呼び出し側が setValue で合わせ直す。
  public setRange(min: number, max: number): void {
    this.element.min = String(min);
    this.element.max = String(max);
  }

  // ratio(0..1)まで満ちたグラデーションをトラック背景に描く。1 以上なら単色トラックへ戻す。
  public setGradient(ratio: number): void {
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
  public setValidRange(minRatio: number, maxRatio: number): void {
    const lo = Math.max(0, minRatio) * 100;
    const hi = Math.min(1, maxRatio) * 100;
    // 全域が有効なら単色トラックへ戻す。
    if (lo <= 0 && hi >= 100) {
      this.element.style.background = '';
    } else if (lo >= hi) {
      // 全域が無効なら減光した単色トラックにする。
      this.element.style.background = 'var(--fill-2)';
    } else {
      // 区間の内外で色を切り替えたグラデーションを描く。
      this.element.style.background =
        `linear-gradient(to right, var(--fill-2) 0%, var(--fill-2) ${lo}%, var(--fill-4) ${lo}%, var(--fill-4) ${hi}%, var(--fill-2) ${hi}%, var(--fill-2) 100%)`;
    }
  }

  // 区間ごとの濃淡をトラック背景に描く。bands は終端の昇順で、最後の終端より先は塗らない。
  public setBands(bands: readonly SliderBand[]): void {
    let from = 0;
    const stops: string[] = [];
    for (const { to, tone } of bands) {
      const end = Math.max(from, Math.min(1, to));
      stops.push(`${BAND_FILL[tone]} ${from * 100}% ${end * 100}%`);
      from = end;
    }
    this.element.style.background = stops.length === 0 ? '' : `linear-gradient(to right, ${stops.join(', ')})`;
  }

  // 目盛りを載せる(marked のトラックだけ)。要素は使い回し、変わった値だけ書く。目盛りを押すと、
  // その index で onSelect が呼ばれる。
  public setMarks(marks: readonly SliderMark[], onSelect: (index: number) => void): void {
    const layer = this.markLayer;
    if (layer === null) return;
    this.onMarkSelect = onSelect;
    while (layer.childElementCount > marks.length) layer.lastElementChild?.remove();
    while (layer.childElementCount < marks.length) layer.appendChild(this.buildMark(layer.childElementCount));
    marks.forEach((mark, i) => {
      const el = layer.children[i];
      if (!(el instanceof HTMLElement)) return;
      const at = String(mark.at);
      if (el.style.getPropertyValue('--at') !== at) el.style.setProperty('--at', at);
      if (el.dataset['glyph'] !== mark.glyph) el.dataset['glyph'] = mark.glyph;
      if (el.title !== mark.title) el.title = mark.title;
      el.classList.toggle('is-own', mark.tone === 'own');
      el.classList.toggle('is-target', mark.tone === 'target');
    });
  }

  // 押すとその目盛りを選ぶ1本。ドラッグはつまみ(入力欄)が受け持ち、目盛りは押下だけを扱う。
  private buildMark(index: number): HTMLElement {
    const el = document.createElement('span');
    el.className = 'w-slider-mark';
    stopDragPropagation(el);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onMarkSelect?.(index);
    });
    return el;
  }
}
