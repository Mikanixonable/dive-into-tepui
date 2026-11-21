import { buildLabeledRow, Slider, ValueInput } from '../../hud-kit/widgets';

// 軌道要素の数値入力に、値の範囲を操作するスライダーを添える。
function buildNumberRow(label: string, defaultValue: number, step: number, min?: number, max?: number): { row: HTMLElement; input: HTMLInputElement } {
  const row = buildLabeledRow(label);
  const valueInput = new ValueInput({ type: 'number', step, min, max }, () => {});
  valueInput.setValue(String(defaultValue));
  row.appendChild(valueInput.element);
  return { row, input: valueInput.element };
}

// ラベル付き数値入力を1行分組み立てて root へ追加し、input 要素を返す。
export function numberField(root: HTMLElement, label: string, defaultValue: number, step: number, min?: number, max?: number): HTMLInputElement {
  const { row, input } = buildNumberRow(label, defaultValue, step, min, max);
  root.appendChild(row);
  return input;
}

// numberField が組んだ入力の行(ラベルごと)を出し入れする。
export function setFieldVisible(input: HTMLInputElement, visible: boolean): void {
  (input.parentElement as HTMLElement).classList.toggle('hidden', !visible);
}

// numberField にスライダー+目盛りを添えた行。数値入力とスライダーは双方向に同期する。
// 値⇔スライダー位置(0..1)の対応と目盛りラベルは呼び出し側が bindAngleSlider/
// bindEccentricitySlider/bindRelativeSlider 経由で決める(角度・離心率は固定範囲の線形対応、
// 半長軸・周期・高度は上限がなく基準値相対の対応になるため、この行自体は対応関係を知らない)。
export interface SliderRow {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  readonly slider: HTMLInputElement;
  setLabel(text: string): void;
  setTicks(labels: readonly string[]): void;
  setMapping(toT: (value: number) => number, fromT: (t: number) => number): void;
  // 相対スライダーの中心値を現在の input.value へ合わせる。
  rebase?(): void;
}

// 数値入力とスライダーを同期する行を root へ追加する。
export function sliderField(root: HTMLElement, label: string, defaultValue: number, step: number, min?: number, max?: number): SliderRow {
  const wrap = document.createElement('div');
  wrap.className = 'slider-field';

  const { row, input } = buildNumberRow(label, defaultValue, step, min, max);

  const sliderCol = document.createElement('div');
  sliderCol.className = 'slider-col';

  const slider = new Slider({ min: 0, max: 1000, step: 1 }, (v) => {
    // 次のドラッグの基準値を安定させるため、入力欄の刻みに丸めて書き戻す。
    input.value = String(Math.round(fromT(v / 1000) / step) * step);
  });
  sliderCol.appendChild(slider.element);

  const ticksEl = document.createElement('div');
  ticksEl.className = 'slider-ticks';
  sliderCol.appendChild(ticksEl);

  row.appendChild(sliderCol);
  wrap.appendChild(row);

  root.appendChild(wrap);

  let toT = (v: number): number => v;
  let fromT = (t: number): number => t;
  // 入力値を正規化したスライダー位置へ反映する。
  const syncSliderFromInput = (): void => {
    const t = Math.max(0, Math.min(1, toT(Number(input.value))));
    slider.setValue(Math.round(t * 1000));
  };
  input.addEventListener('input', syncSliderFromInput);

  const titleEl = row.querySelector('.w-group-title');

  return {
    element: wrap,
    input,
    slider: slider.element,
    // 入力行の見出しを更新する。
    setLabel(text) {
      if (titleEl) titleEl.textContent = text;
    },
    // 目盛りの表示を labels の並びへ揃える。
    setTicks(labels) {
      ticksEl.innerHTML = '';
      for (const text of labels) {
        const span = document.createElement('span');
        span.textContent = text;
        ticksEl.appendChild(span);
      }
    },
    // 値から位置・位置から値への変換を設定し、現在値を反映する。
    setMapping(newToT, newFromT) {
      toT = newToT;
      fromT = newFromT;
      syncSliderFromInput();
    },
  };
}

// 角度スライダー(i/Ω/ω/ν): 0..rangeDeg の線形対応、90度ごとに目盛りを表示する。
export function bindAngleSlider(field: SliderRow, rangeDeg: number): void {
  field.setMapping((v) => v / rangeDeg, (t) => t * rangeDeg);
  const tickCount = rangeDeg / 90 + 1;
  field.setTicks(Array.from({ length: tickCount }, (_, i) => `${i * 90}°`));
}

// 離心率スライダー: 0..0.99 の線形対応、0/0.25/0.5/0.75/0.99 に目盛りを表示する。
export function bindEccentricitySlider(field: SliderRow): void {
  const max = 0.99;
  field.setMapping((v) => v / max, (t) => t * max);
  field.setTicks([0, 0.25, 0.5, 0.75, 0.99].map((v) => v.toFixed(2)));
}

// SliderRow へ値を書き込む。input イベントの発火と基準値の取り直しまで含む —
// rebase を欠くとつまみの位置が新しい値と食い違う。
export function setSliderValue(row: SliderRow, value: number): void {
  row.input.value = String(value);
  row.input.dispatchEvent(new Event('input'));
  row.rebase?.();
}

// 基準値相対スライダーの倍率: 中央(t=0)を基準値の100%とし、左は等倍で0%まで、
// 右は2倍指数で400%まで伸びる。上限のない量を有限のスライダー幅で操作するための仕様。
function relativeMultiplier(tOffset: number): number {
  return tOffset <= 0 ? 1 + tOffset : Math.pow(2, 2 * tOffset);
}

// 値をスライダー中央の基準へ写し、0 近傍でも正値へ戻れる基準床を受け取る。
export function bindRelativeSlider(field: SliderRow, refFloor: number): void {
  // 現在値を新しい中心として、目盛りと双方向変換を揃える。
  const rebase = (): void => {
    // 現在値を相対スライダーの中心へ据える。
    const ref = Math.max(Number(field.input.value), refFloor);
    field.setMapping(
      (v) => {
        const mult = v / ref;
        const tOffset = mult <= 1 ? mult - 1 : Math.log2(mult) / 2;
        return (tOffset + 1) / 2;
      },
      (t) => ref * relativeMultiplier(2 * t - 1),
    );
    field.setTicks([0, 0.5, 1, 2, 4].map((m) => `${Math.round((ref * m) * 100) / 100}`));
  };
  field.slider.addEventListener('pointerdown', rebase);
  field.slider.addEventListener('pointerup', rebase);
  field.rebase = rebase;
  rebase();
}
