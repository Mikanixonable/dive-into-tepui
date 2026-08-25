// 軌道ガイドの設定行に使う「スライダー+数値入力」と色入力の部品。値そのものの意味(0〜1 の
// 族範囲、対数の振幅、位相のラジアン)は写像として持ち、行の組み立てと同期を1箇所へ集約する。
import { Slider, ValueInput } from '../widgets';
import { MAX_LINES_PER_KIND, MAX_ZERO_VELOCITY_CURVES } from '../../celestial/orbit-guide-settings';


export interface ValueMapping {
  readonly sliderMin: number;
  readonly sliderMax: number;
  readonly sliderStep: number;
  readonly toSlider: (value: number) => number;
  readonly fromSlider: (raw: number) => number;
  readonly format: (value: number) => string;
  readonly parse: (text: string) => number;
  readonly inputMin: number;
  readonly inputMax: number;
  readonly inputStep: number;
  readonly unit?: string;
}

function clamp(value: number, lo: number, hi: number): number {
  return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;
}

export const RANGE_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 100, sliderStep: 1,
  toSlider: (v) => Math.round(v * 100), fromSlider: (raw) => raw / 100,
  format: (v) => v.toFixed(2), parse: (text) => clamp(Number(text), 0, 1),
  inputMin: 0, inputMax: 1, inputStep: 0.01,
};

export const OPACITY_MAPPING: ValueMapping = RANGE_MAPPING;

export const COUNT_MAPPING: ValueMapping = {
  sliderMin: 1, sliderMax: MAX_LINES_PER_KIND, sliderStep: 1,
  toSlider: (v) => Math.round(v), fromSlider: (raw) => Math.round(raw),
  format: (v) => String(Math.round(v)), parse: (text) => Math.round(clamp(Number(text), 1, MAX_LINES_PER_KIND)),
  inputMin: 1, inputMax: MAX_LINES_PER_KIND, inputStep: 1,
};

const AMPLITUDE_MIN_M = 1_000_000;
const AMPLITUDE_MAX_M = 200_000_000;
function metersToKm(m: number): number { return m / 1000; }
function kmToMeters(km: number): number { return km * 1000; }
export const AMPLITUDE_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 1000, sliderStep: 1,
  toSlider: (m) => {
    const ratio = AMPLITUDE_MAX_M / AMPLITUDE_MIN_M;
    const clamped = clamp(m, AMPLITUDE_MIN_M, AMPLITUDE_MAX_M);
    return Math.round((Math.log(clamped / AMPLITUDE_MIN_M) / Math.log(ratio)) * 1000);
  },
  fromSlider: (raw) => {
    const ratio = AMPLITUDE_MAX_M / AMPLITUDE_MIN_M;
    return AMPLITUDE_MIN_M * Math.pow(ratio, raw / 1000);
  },
  format: (m) => metersToKm(m).toFixed(0),
  parse: (text) => kmToMeters(clamp(Number(text), metersToKm(AMPLITUDE_MIN_M), metersToKm(AMPLITUDE_MAX_M))),
  inputMin: metersToKm(AMPLITUDE_MIN_M), inputMax: metersToKm(AMPLITUDE_MAX_M), inputStep: 100,
  unit: 'km',
};

export const PHASE_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 628, sliderStep: 1,
  toSlider: (v) => Math.round((v / (2 * Math.PI)) * 628), fromSlider: (raw) => (raw / 628) * 2 * Math.PI,
  format: (v) => v.toFixed(2), parse: (text) => clamp(Number(text), 0, 2 * Math.PI),
  inputMin: 0, inputMax: Number((2 * Math.PI).toFixed(2)), inputStep: 0.01, unit: 'rad',
};

export const CYCLES_MAPPING: ValueMapping = {
  sliderMin: 1, sliderMax: 30, sliderStep: 1,
  toSlider: (v) => Math.round(v), fromSlider: (raw) => Math.round(raw),
  format: (v) => String(Math.round(v)), parse: (text) => Math.round(clamp(Number(text), 1, 30)),
  inputMin: 1, inputMax: 30, inputStep: 1,
};

// ゼロ速度曲線のヤコビ定数。地球-月系(L1≈3.19)から太陽-地球系(L1≈3.0000009)まで跨ぐので、
// 実務上使う範囲を広めに取る。
export const JACOBI_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 4000, sliderStep: 1,
  toSlider: (v) => Math.round((v - 2.5) * 1000), fromSlider: (raw) => 2.5 + raw / 1000,
  format: (v) => v.toFixed(4), parse: (text) => clamp(Number(text), 2.5, 6.5),
  inputMin: 2.5, inputMax: 6.5, inputStep: 0.0001,
};

export interface ValueField {
  readonly row: HTMLElement;
  readonly slider: Slider;
  readonly input: ValueInput;
}

export function buildValueField(label: string, mapping: ValueMapping, onCommit: (value: number) => void): ValueField {
  const row = document.createElement('div');
  row.className = 'w-group orbit-guide-value-row';
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = label;
  row.appendChild(heading);

  const sliderCol = document.createElement('div');
  sliderCol.className = 'slider-col';
  row.appendChild(sliderCol);

  const slider = new Slider({ min: mapping.sliderMin, max: mapping.sliderMax, step: mapping.sliderStep }, (raw) => {
    const value = mapping.fromSlider(raw);
    input.setValue(mapping.format(value));
    onCommit(value);
  });
  sliderCol.appendChild(slider.element);

  const input = new ValueInput({
    type: 'number', min: mapping.inputMin, max: mapping.inputMax, step: mapping.inputStep,
  }, (text) => {
    const value = mapping.parse(text);
    slider.setValue(mapping.toSlider(value));
    input.setValue(mapping.format(value));
    onCommit(value);
  });
  row.appendChild(input.element);

  if (mapping.unit !== undefined) {
    const unit = document.createElement('span');
    unit.className = 'orbit-guide-value-unit';
    unit.textContent = mapping.unit;
    row.appendChild(unit);
  }
  return { row, slider, input };
}

export function syncValueField(field: ValueField, mapping: ValueMapping, value: number): void {
  if (document.activeElement !== field.input.element) field.input.setValue(mapping.format(value));
  field.slider.setValue(mapping.toSlider(value));
}

export function buildColorField(label: string, value: number, onCommit: (value: number) => void): { readonly row: HTMLElement; readonly input: ValueInput } {
  const row = document.createElement('div');
  row.className = 'w-group orbit-guide-color-row';
  const heading = document.createElement('span');
  heading.className = 'w-group-title';
  heading.textContent = label;
  row.appendChild(heading);
  const input = new ValueInput({ type: 'color' }, (text) => onCommit(Number.parseInt(text.slice(1), 16)));
  input.setValue(hexColorString(value));
  row.appendChild(input.element);
  return { row, input };
}

export function hexColorString(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

// ゼロ速度曲線を何本描くか。上限は設定モジュールが持つ。
export const ZERO_VELOCITY_COUNT_MAPPING: ValueMapping = {
  sliderMin: 1, sliderMax: MAX_ZERO_VELOCITY_CURVES, sliderStep: 1,
  toSlider: (v) => Math.round(v), fromSlider: (raw) => Math.round(raw),
  format: (v) => String(Math.round(v)),
  parse: (text) => Math.round(clamp(Number(text), 1, MAX_ZERO_VELOCITY_CURVES)),
  inputMin: 1, inputMax: MAX_ZERO_VELOCITY_CURVES, inputStep: 1,
};
