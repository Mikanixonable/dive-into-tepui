// 建造部品と船体性能の数値表記を揃える。
export type ConstructionMetricUnit = '' | 'kg' | 'N' | 'W' | 'm²' | 'm/s' | 'm/s²';

// 建造数値に単位を添え、推力・電力は絶対値1000以上を kilo 表記にする。
export function formatConstructionMetric(value: number, unit: ConstructionMetricUnit): string {
  const body = formatConstructionDelta(value, unit);
  if (unit === 'N' && Math.abs(value) >= 1000) return `${body} kN`;
  if (unit === 'W' && Math.abs(value) >= 1000) return `${body} kW`;
  return unit === '' ? body : `${body} ${unit}`;
}

// 差分を metric と同じ尺度で表す。単位は差分の前に出る変化後の値が持つので付けない。
export function formatConstructionDelta(value: number, unit: ConstructionMetricUnit): string {
  const abs = Math.abs(value);
  if ((unit === 'N' || unit === 'W') && abs >= 1000) return formatDecimal(value / 1000);
  if (unit === 'm²' || unit === 'm/s' || unit === 'm/s²') return formatDecimal(value);
  return formatConstructionNumber(value);
}

// 小数表記は絶対値100以上を整数に丸め、それ以外を小数1桁にする。
function formatDecimal(value: number): string {
  return Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

// 建造数値を整数に丸め、ロケールに応じた桁区切りを付ける。
export function formatConstructionNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

// 向きを「回転角 · 取り付ける端」の1行で表す。
export function formatConstructionOrientation(orientation: { readonly roll: number; readonly face: 'front' | 'back' }): string {
  const degrees = ((orientation.roll % 4) + 4) % 4 * 90;
  return `${degrees}° · ${orientation.face === 'front' ? '前端' : '後端'}で取り付け`;
}
