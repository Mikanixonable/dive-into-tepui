import { Slider, ValueInput } from '../hud/widgets';

// ラベル行(.w-group + .w-group-title)と数値入力を組み立てて返す。root への追加は呼び出し側の仕事
// (numberField はそのまま追加するだけだが、sliderField はスライダー列を同じ行に足してから追加する)。
// 値は打鍵のたびに(sliderField が)直接読み書きするので、ValueInput の commit 通知自体は使わない。
function buildNumberRow(label: string, defaultValue: number, step: number, min?: number, max?: number): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'w-group';
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = label;
  row.appendChild(heading);
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
  // bindRelativeSlider が結んだ行にだけ立つ: 基準値相対スライダーの基準をいまの input.value へ
  // 取り直す。値を外部から書き換えたときはこれも呼ばないと、つまみの位置が実際の値とずれる。
  rebase?(): void;
}

export function sliderField(root: HTMLElement, label: string, defaultValue: number, step: number, min?: number, max?: number): SliderRow {
  const wrap = document.createElement('div');
  wrap.className = 'slider-field';

  const { row, input } = buildNumberRow(label, defaultValue, step, min, max);

  const sliderCol = document.createElement('div');
  sliderCol.className = 'slider-col';

  const slider = new Slider({ min: 0, max: 1000, step: 1 }, () => {}).element;
  sliderCol.appendChild(slider);

  const ticksEl = document.createElement('div');
  ticksEl.className = 'slider-ticks';
  sliderCol.appendChild(ticksEl);

  row.appendChild(sliderCol);
  wrap.appendChild(row);

  root.appendChild(wrap);

  let toT = (v: number): number => v;
  let fromT = (t: number): number => t;
  const syncSliderFromInput = (): void => {
    const t = Math.max(0, Math.min(1, toT(Number(input.value))));
    slider.value = String(Math.round(t * 1000));
  };
  input.addEventListener('input', syncSliderFromInput);
  slider.addEventListener('input', () => {
    // 入力欄の刻みへ丸めてから書き戻す。高度スライダーは書き戻した値を次のドラッグの基準に
    // 取り直すので、丸めないと端数がドラッグのたびに積み上がる。
    input.value = String(Math.round(fromT(Number(slider.value) / 1000) / step) * step);
  });

  const titleEl = row.querySelector('.w-group-title');

  return {
    element: wrap,
    input,
    slider,
    setLabel(text) {
      if (titleEl) titleEl.textContent = text;
    },
    setTicks(labels) {
      ticksEl.innerHTML = '';
      for (const text of labels) {
        const span = document.createElement('span');
        span.textContent = text;
        ticksEl.appendChild(span);
      }
    },
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

// 基準値相対スライダーの倍率: 中央(t=0)を基準値の100%とし、左は等倍で0%まで、
// 右は2倍指数で400%まで伸びる。上限のない量を有限のスライダー幅で操作するための仕様。
function relativeMultiplier(tOffset: number): number {
  return tOffset <= 0 ? 1 + tOffset : Math.pow(2, 2 * tOffset);
}

// 基準値相対スライダー(Ap/Pe高度・半長軸・周期): ドラッグ開始時点の値を基準の100%として
// スライダー中央に据え、ドラッグが終わるたびにそのときの値を新しい基準に取り直してつまみを
// 中央へ戻す(基準を固定しないと上限のない量を動かせない)。refFloor は基準値の下限 —
// 基準はスライダーの可動範囲そのものなので、値が 0 まで下がったときに 0 を基準にすると倍率を
// いくら掛けても 0 のままになり、二度と操作で戻せなくなる。量ごとに単位・オーダーが違うので
// 呼び出し側がその量にとって妥当な床を渡す。
export function bindRelativeSlider(field: SliderRow, refFloor: number): void {
  const rebase = (): void => {
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
