// 注意・警告の判定(FLIGHT.md「警報の条件」)。行・メーター・警報灯・警報帯のどこで読んでも
// 同じ結果になるよう、閾値と判定をここ1か所に置く。判定は物理量と上限だけから決まる。
// 入る閾値と戻る閾値を分け、直前の段 previous を渡すと境界で明滅しない段を返す。
import { worstAlarmLevel, type AlarmLevel } from '../../hud/alarm-level';

// 船体温度が上限のこの割合に達すると注意・警告に入り、割合がこの値を下回ると戻る。
export const TEMPERATURE_CAUTION_RATIO = 0.7;
export const TEMPERATURE_WARNING_RATIO = 0.9;
const TEMPERATURE_CAUTION_LEAVE_RATIO = 0.62;
const TEMPERATURE_WARNING_LEAVE_RATIO = 0.82;

// 動圧が上限のこの割合に達すると注意・警告に入り、割合がこの値を下回ると戻る。
export const DYNAMIC_PRESSURE_CAUTION_RATIO = 0.5;
export const DYNAMIC_PRESSURE_WARNING_RATIO = 0.8;
const DYNAMIC_PRESSURE_CAUTION_LEAVE_RATIO = 0.4;
const DYNAMIC_PRESSURE_WARNING_LEAVE_RATIO = 0.7;

// 燃料が満載のこの割合まで減ると注意・警告に入り、割合がこの値へ戻ると戻る。
export const FUEL_CAUTION_RATIO = 0.2;
export const FUEL_WARNING_RATIO = 0.05;
const FUEL_CAUTION_LEAVE_RATIO = 0.25;
const FUEL_WARNING_LEAVE_RATIO = 0.08;

// 装甲が最大のこの割合まで減ると警告。
export const ARMOR_WARNING_RATIO = 0.3;

// 予備の弾倉がこの数まで減ると注意。
const AMMO_CAUTION_MAGS = 1;

// 高度 [m] がこの値を下回ると注意・警告に入り、この値を上回ると戻る。降下中(降下率の警告)も注意。
const ALTITUDE_CAUTION_M = 120e3;
const ALTITUDE_CAUTION_LEAVE_M = 125e3;
const ALTITUDE_WARNING_M = 80e3;
const ALTITUDE_WARNING_LEAVE_M = 85e3;

// 入る閾値で求めた段 entered と、戻る閾値で求めた段 held から、境界で明滅しない段を返す。
// 直前の段 previous は、戻る閾値を割るまで(held まで)保つ。
function withHysteresis(entered: AlarmLevel, held: AlarmLevel, previous: AlarmLevel): AlarmLevel {
  const kept: AlarmLevel = previous === 'warning' && held === 'warning' ? 'warning'
    : previous !== 'normal' && held !== 'normal' ? 'caution'
      : 'normal';
  return worstAlarmLevel(entered, kept);
}

// 値が大きいほど悪い量の段。ratio は上限に対する割合で、上限が無い(0 以下)ときは判定しない。
function highRatioLevel(
  value: number, max: number, cautionRatio: number, warningRatio: number,
  cautionLeaveRatio: number, warningLeaveRatio: number, previous: AlarmLevel,
): AlarmLevel {
  if (!(max > 0)) return 'normal';
  const ratio = value / max;
  const entered: AlarmLevel = ratio >= warningRatio ? 'warning' : ratio >= cautionRatio ? 'caution' : 'normal';
  const held: AlarmLevel = ratio >= warningLeaveRatio ? 'warning' : ratio >= cautionLeaveRatio ? 'caution' : 'normal';
  return withHysteresis(entered, held, previous);
}

// 値が小さいほど悪い量の段。割合は満載(最大)に対するもので、満載が無い(0 以下)ときは判定しない。
function lowRatioLevel(
  value: number, max: number, cautionRatio: number, warningRatio: number,
  cautionLeaveRatio: number, warningLeaveRatio: number, previous: AlarmLevel,
): AlarmLevel {
  if (!(max > 0)) return 'normal';
  const ratio = value / max;
  const entered: AlarmLevel = ratio <= warningRatio ? 'warning' : ratio <= cautionRatio ? 'caution' : 'normal';
  const held: AlarmLevel = ratio < warningLeaveRatio ? 'warning' : ratio < cautionLeaveRatio ? 'caution' : 'normal';
  return withHysteresis(entered, held, previous);
}

// 船体温度 [K] の段。
export function temperatureAlarmLevel(
  temperatureK: number, maxTemperatureK: number, previous: AlarmLevel = 'normal',
): AlarmLevel {
  return highRatioLevel(
    temperatureK, maxTemperatureK, TEMPERATURE_CAUTION_RATIO, TEMPERATURE_WARNING_RATIO,
    TEMPERATURE_CAUTION_LEAVE_RATIO, TEMPERATURE_WARNING_LEAVE_RATIO, previous,
  );
}

// 動圧 [Pa] の段。
export function dynamicPressureAlarmLevel(
  pressurePa: number, maxPressurePa: number, previous: AlarmLevel = 'normal',
): AlarmLevel {
  return highRatioLevel(
    pressurePa, maxPressurePa, DYNAMIC_PRESSURE_CAUTION_RATIO, DYNAMIC_PRESSURE_WARNING_RATIO,
    DYNAMIC_PRESSURE_CAUTION_LEAVE_RATIO, DYNAMIC_PRESSURE_WARNING_LEAVE_RATIO, previous,
  );
}

// 燃料の段。fuel と maxFuel は同じ単位で、maxFuel が 0 以下(燃料を積まない)なら判定しない。
export function fuelAlarmLevel(fuel: number, maxFuel: number, previous: AlarmLevel = 'normal'): AlarmLevel {
  return lowRatioLevel(
    fuel, maxFuel, FUEL_CAUTION_RATIO, FUEL_WARNING_RATIO,
    FUEL_CAUTION_LEAVE_RATIO, FUEL_WARNING_LEAVE_RATIO, previous,
  );
}

// 高度 [m] の段。descending は降下率の警告が掛かっているか(降下率の入る・戻る閾値は
// AltitudeAlarm が持つ)で、掛かっている間は注意。
export function altitudeAlarmLevel(
  altitudeM: number, descending: boolean, previous: AlarmLevel = 'normal',
): AlarmLevel {
  const entered: AlarmLevel = altitudeM < ALTITUDE_WARNING_M ? 'warning'
    : altitudeM < ALTITUDE_CAUTION_M || descending ? 'caution'
      : 'normal';
  const held: AlarmLevel = altitudeM < ALTITUDE_WARNING_LEAVE_M ? 'warning'
    : altitudeM < ALTITUDE_CAUTION_LEAVE_M ? 'caution'
      : 'normal';
  return withHysteresis(entered, held, previous);
}

// 装甲の段。注意の段は持たない。
export function armorAlarmLevel(hp: number, maxHp: number): AlarmLevel {
  if (!(maxHp > 0)) return 'normal';
  return hp / maxHp <= ARMOR_WARNING_RATIO ? 'warning' : 'normal';
}

// 弾薬の段。roundsInMag は装填中の弾倉の残弾、magsLeft は予備の弾倉の数。
// 弾が尽きる(装填中も予備も無い)と警告、予備が少ないと注意。個数が離散なので戻る閾値は持たない。
export function ammoAlarmLevel(roundsInMag: number, magsLeft: number): AlarmLevel {
  if (roundsInMag <= 0 && magsLeft <= 0) return 'warning';
  if (magsLeft <= AMMO_CAUTION_MAGS) return 'caution';
  return 'normal';
}
