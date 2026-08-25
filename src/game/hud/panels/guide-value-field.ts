// 軌道ガイドの設定行に使う「スライダー+数値入力」と色入力の部品。値そのものの意味(0〜1 の
// 族範囲、対数の振幅、位相のラジアン)は写像として持ち、行の組み立てと同期を1箇所へ集約する。
import { Slider, ValueInput } from '../widgets';
import {
  MAX_LINES_PER_KIND, MAX_ZERO_VELOCITY_CURVES, type DirectionMarkerMode,
} from '../../celestial/orbit-guide-settings';

// 進行方向マーカーの出し方(SegmentedControl の選択肢)。族・地球専用参照軌道の双方が使う。
export const DIRECTION_ITEMS: readonly (readonly [DirectionMarkerMode, string])[] = [
  ['none', '表示しない'], ['single', '1周に1つ'], ['many', '多数'],
];


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

// リサジュー軌道の振幅(L点局所γ単位に対する無次元比)。系ごとに実距離換算が数桁違うため
// 無次元で持ち、Richardson近似が発散しない目安の範囲(0〜0.3)に収める。
const LISSAJOUS_AMPLITUDE_MIN = 0.01;
const LISSAJOUS_AMPLITUDE_MAX = 0.3;
export const AMPLITUDE_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 1000, sliderStep: 1,
  toSlider: (v) => {
    const ratio = LISSAJOUS_AMPLITUDE_MAX / LISSAJOUS_AMPLITUDE_MIN;
    const clamped = clamp(v, LISSAJOUS_AMPLITUDE_MIN, LISSAJOUS_AMPLITUDE_MAX);
    return Math.round((Math.log(clamped / LISSAJOUS_AMPLITUDE_MIN) / Math.log(ratio)) * 1000);
  },
  fromSlider: (raw) => {
    const ratio = LISSAJOUS_AMPLITUDE_MAX / LISSAJOUS_AMPLITUDE_MIN;
    return LISSAJOUS_AMPLITUDE_MIN * Math.pow(ratio, raw / 1000);
  },
  format: (v) => v.toFixed(3),
  parse: (text) => clamp(Number(text), LISSAJOUS_AMPLITUDE_MIN, LISSAJOUS_AMPLITUDE_MAX),
  inputMin: LISSAJOUS_AMPLITUDE_MIN, inputMax: LISSAJOUS_AMPLITUDE_MAX, inputStep: 0.01,
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
  // 太陽-地球系の C(L1)〜C(L5) は 3.0000 付近へ 10⁻⁵ の幅で密集するので、スライダーも表示も
  // その差が見える刻みにする(地球-月系は 3.0〜3.2 に広がるので同じ刻みで足りる)。
  sliderMin: 0, sliderMax: 40000, sliderStep: 1,
  toSlider: (v) => Math.round((clamp(v, 2.5, 6.5) - 2.5) * 10000),
  fromSlider: (raw) => 2.5 + raw / 10000,
  format: (v) => v.toFixed(5),
  parse: (text) => clamp(Number(text), 2.5, 6.5),
  inputMin: 2.5, inputMax: 6.5, inputStep: 0.00001,
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

// 太陽同期準回帰軌道・ドーンダスク軌道の回帰日数(整数日)。実用域の1〜30日を取る。
export const REPEAT_DAYS_MAPPING: ValueMapping = {
  sliderMin: 1, sliderMax: 30, sliderStep: 1,
  toSlider: (v) => Math.round(v), fromSlider: (raw) => Math.round(raw),
  format: (v) => String(Math.round(v)), parse: (text) => Math.round(clamp(Number(text), 1, 30)),
  inputMin: 1, inputMax: 30, inputStep: 1,
};

// 回帰日数の間に周回する回数(整数)。高度200km前後で1日16周弱になるので、30日ぶんまで
// 動かせるよう上限を広めに取る。太陽同期条件を満たさない組み合わせはガイド線が消えるだけで
// 範囲自体は曲げない(計画書 8 の #9 と同じ方針)。
export const REVS_PER_REPEAT_MAPPING: ValueMapping = {
  sliderMin: 1, sliderMax: 480, sliderStep: 1,
  toSlider: (v) => Math.round(v), fromSlider: (raw) => Math.round(raw),
  format: (v) => String(Math.round(v)), parse: (text) => Math.round(clamp(Number(text), 1, 480)),
  inputMin: 1, inputMax: 480, inputStep: 1,
};

// 近地点高度 [m]。モルニヤ・ツンドラ軌道の実用域(数百 km)を UI 上は km で見せる。
export const PERIGEE_ALTITUDE_MAPPING: ValueMapping = {
  sliderMin: 200, sliderMax: 2000, sliderStep: 10,
  toSlider: (v) => Math.round(clamp(v / 1000, 200, 2000)), fromSlider: (raw) => raw * 1000,
  format: (v) => (v / 1000).toFixed(0), parse: (text) => clamp(Number(text), 200, 2000) * 1000,
  inputMin: 200, inputMax: 2000, inputStep: 10, unit: 'km',
};

// 昇交点赤経 [deg]。
export const RAAN_MAPPING: ValueMapping = {
  sliderMin: 0, sliderMax: 3600, sliderStep: 1,
  toSlider: (v) => Math.round(v * 10), fromSlider: (raw) => raw / 10,
  format: (v) => v.toFixed(1), parse: (text) => clamp(Number(text), 0, 360),
  inputMin: 0, inputMax: 360, inputStep: 0.1, unit: '°',
};

// ゼロ速度曲線を何本描くか。上限は設定モジュールが持つ。
export const ZERO_VELOCITY_COUNT_MAPPING: ValueMapping = {
  sliderMin: 1, sliderMax: MAX_ZERO_VELOCITY_CURVES, sliderStep: 1,
  toSlider: (v) => Math.round(v), fromSlider: (raw) => Math.round(raw),
  format: (v) => String(Math.round(v)),
  parse: (text) => Math.round(clamp(Number(text), 1, MAX_ZERO_VELOCITY_CURVES)),
  inputMin: 1, inputMax: MAX_ZERO_VELOCITY_CURVES, inputStep: 1,
};
