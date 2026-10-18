// 注意・警告の判定(FLIGHT.md「警報の条件」)。行・メーター・警報灯・警報帯のどこで読んでも
// 同じ結果になるよう、閾値と判定をここ1か所に置く。判定は物理量と上限だけから決まる。
import type { AlarmLevel } from '../../hud/alarm-level';

// 船体温度が上限のこの割合に達すると注意・警告。
export const TEMPERATURE_CAUTION_RATIO = 0.7;
export const TEMPERATURE_WARNING_RATIO = 0.9;

// 動圧が上限のこの割合に達すると注意・警告。
export const DYNAMIC_PRESSURE_CAUTION_RATIO = 0.5;
export const DYNAMIC_PRESSURE_WARNING_RATIO = 0.8;

// 燃料が満載のこの割合まで減ると注意・警告。
export const FUEL_CAUTION_RATIO = 0.2;
export const FUEL_WARNING_RATIO = 0.05;

// 装甲が最大のこの割合まで減ると警告。
export const ARMOR_WARNING_RATIO = 0.3;

// 予備の弾倉がこの数まで減ると注意。
const AMMO_CAUTION_MAGS = 1;

// 値が大きいほど悪い量の段。ratio は上限に対する割合で、上限が無い(0 以下)ときは判定しない。
function highRatioLevel(value: number, max: number, cautionRatio: number, warningRatio: number): AlarmLevel {
  if (!(max > 0)) return 'normal';
  const ratio = value / max;
  if (ratio >= warningRatio) return 'warning';
  if (ratio >= cautionRatio) return 'caution';
  return 'normal';
}

// 値が小さいほど悪い量の段。割合は満載(最大)に対するもので、満載が無い(0 以下)ときは判定しない。
function lowRatioLevel(value: number, max: number, cautionRatio: number, warningRatio: number): AlarmLevel {
  if (!(max > 0)) return 'normal';
  const ratio = value / max;
  if (ratio <= warningRatio) return 'warning';
  if (ratio <= cautionRatio) return 'caution';
  return 'normal';
}

// 船体温度 [K] の段。
export function temperatureAlarmLevel(temperatureK: number, maxTemperatureK: number): AlarmLevel {
  return highRatioLevel(temperatureK, maxTemperatureK, TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO);
}

// 動圧 [Pa] の段。
export function dynamicPressureAlarmLevel(pressurePa: number, maxPressurePa: number): AlarmLevel {
  return highRatioLevel(pressurePa, maxPressurePa, DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO);
}

// 燃料の段。fuel と maxFuel は同じ単位で、maxFuel が 0 以下(燃料を積まない)なら判定しない。
export function fuelAlarmLevel(fuel: number, maxFuel: number): AlarmLevel {
  return lowRatioLevel(fuel, maxFuel, FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO);
}

// 装甲の段。注意の段は持たない。
export function armorAlarmLevel(hp: number, maxHp: number): AlarmLevel {
  if (!(maxHp > 0)) return 'normal';
  return hp / maxHp <= ARMOR_WARNING_RATIO ? 'warning' : 'normal';
}

// 弾薬の段。roundsInMag は装填中の弾倉の残弾、magsLeft は予備の弾倉の数。
// 弾が尽きる(装填中も予備も無い)と警告、予備が少ないと注意。
export function ammoAlarmLevel(roundsInMag: number, magsLeft: number): AlarmLevel {
  if (roundsInMag <= 0 && magsLeft <= 0) return 'warning';
  if (magsLeft <= AMMO_CAUTION_MAGS) return 'caution';
  return 'normal';
}
