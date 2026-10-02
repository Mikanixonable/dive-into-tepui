// 建造部品と船体性能の数値表記を揃える。
export type ConstructionMetricUnit = '' | 'kg' | 'N' | 'W' | 'm²';

// 建造数値に単位を添え、推力・電力は絶対値1000以上を kilo 表記にする。
export function formatConstructionMetric(value: number, unit: ConstructionMetricUnit): string {
  const abs = Math.abs(value);
  if (unit === 'N' && abs >= 1000) return `${formatDecimal(value / 1000)} kN`;
  if (unit === 'W' && abs >= 1000) return `${formatDecimal(value / 1000)} kW`;
  if (unit === 'm²') return `${formatDecimal(value)} m²`;
  const body = formatConstructionNumber(value);
  return unit === '' ? body : `${body} ${unit}`;
}

// 小数表記は絶対値100以上を整数に丸め、それ以外を小数1桁にする。
function formatDecimal(value: number): string {
  return Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

// 建造数値を整数に丸め、ロケールに応じた桁区切りを付ける。
export function formatConstructionNumber(value: number): string {
  return Math.round(value).toLocaleString();
}
