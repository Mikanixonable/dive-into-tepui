// 天文時刻の基礎(暦・ユリウス日・時刻系の変換)。
//
// 暦年は天文年計数(年0 = 紀元前1年)を使い、グレゴリオの規則を両方向へ拡張する。
// JavaScript の Date は使わない — 4桁を外れる年で実装依存の挙動を持ち、TDB を
// 表せないため。
//
// CalendarDate とユリウス日の対応は、1日を 86400 秒とする一様な対応である。
// したがって UTC の 23:59:60 のような閏秒そのものは表さない。閏秒が要るコードは
// SPICE/オフセットのアダプタから供給する。

type TimeScale = 'UTC' | 'TT' | 'TDB';
type EphemerisScale = 'TT' | 'TDB';

interface CalendarFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

type CalendarDate<S extends TimeScale = TimeScale> = CalendarFields & { readonly scale: S };
type UtcCalendarDate = CalendarDate<'UTC'>;

interface JulianDate<S extends TimeScale = TimeScale> {
  readonly value: number;
  readonly scale: S;
}

type UtcJulianDate = JulianDate<'UTC'>;
type TtJulianDate = JulianDate<'TT'>;
export type TdbJulianDate = JulianDate<'TDB'>;

// 変化する UTC の定義は呼び出し側が渡す。閏秒表を組み込まないのは意図的 —
// 未来の UTC の瞬は、その情報が無い限り正しく変換できないため。
interface UtcOffsetProvider {
  // 与えた UTC の暦瞬における TAI - UTC [秒]。
  taiMinusUtcSeconds(utc: UtcCalendarDate): number;
}

const TT_MINUS_TAI_SECONDS = 32.184;
export const J2000_JULIAN_DATE = 2451545.0;
export const SECONDS_PER_DAY = 86400;

const UNIX_EPOCH_JULIAN_DATE = 2440587.5;
const DAYS_FROM_CIVIL_EPOCH_TO_UNIX_EPOCH = 719468;

function isInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function assertScale(scale: string): asserts scale is TimeScale {
  if (scale !== 'UTC' && scale !== 'TT' && scale !== 'TDB') {
    throw new RangeError(`unsupported time scale: ${scale}`);
  }
}

function daysInMonth(year: number, month: number): number {
  if (!isInteger(year)) throw new RangeError('year must be an integer');
  if (!isInteger(month) || month < 1 || month > 12) throw new RangeError('month must be an integer from 1 to 12');
  if (month === 2) return isGregorianLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isGregorianLeapYear(year: number): boolean {
  if (!isInteger(year)) throw new RangeError('year must be an integer');
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function validateCalendarDate<S extends TimeScale>(date: CalendarDate<S>): CalendarDate<S> {
  assertScale(date.scale);
  if (!isInteger(date.year)) throw new RangeError('year must be an integer');
  if (!isInteger(date.month) || date.month < 1 || date.month > 12) {
    throw new RangeError('month must be an integer from 1 to 12');
  }
  const monthLength = daysInMonth(date.year, date.month);
  if (!isInteger(date.day) || date.day < 1 || date.day > monthLength) {
    throw new RangeError(`day must be an integer from 1 to ${monthLength}`);
  }
  if (!isInteger(date.hour) || date.hour < 0 || date.hour > 23) {
    throw new RangeError('hour must be an integer from 0 to 23');
  }
  if (!isInteger(date.minute) || date.minute < 0 || date.minute > 59) {
    throw new RangeError('minute must be an integer from 0 to 59');
  }
  assertFinite(date.second, 'second');
  if (date.second < 0 || date.second >= 60) {
    throw new RangeError('second must be in the half-open interval [0, 60)');
  }
  return date;
}

export function createCalendarDate<S extends TimeScale>(scale: S, fields: CalendarFields): CalendarDate<S> {
  assertScale(scale);
  return validateCalendarDate({ ...fields, scale });
}

export function createJulianDate<S extends TimeScale>(scale: S, value: number): JulianDate<S> {
  assertScale(scale);
  assertFinite(value, 'Julian Date');
  return { value, scale };
}

// 明示した時刻系の、拡張年を持つ ISO 風の暦タイムスタンプを読む。
export function parseCalendarDate<S extends TimeScale>(text: string, scale: S): CalendarDate<S> {
  const match = /^(?<year>[+-]?\d{4,})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2}(?:\.\d+)?)(?<z>Z)?$/.exec(text);
  if (!match?.groups) throw new RangeError(`invalid calendar date: ${text}`);
  if (match.groups.z !== undefined && scale !== 'UTC') {
    throw new RangeError('Z suffix is only valid for UTC calendar dates');
  }
  return createCalendarDate(scale, {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
    day: Number(match.groups.day),
    hour: Number(match.groups.hour),
    minute: Number(match.groups.minute),
    second: Number(match.groups.second),
  });
}

// 1970-01-01 からの日数(予測グレゴリオ暦)。Howard Hinnant の整数演算を、
// 符号付き年を許して天文年計数へ拡張したもの。
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfMarch = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfMarch + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - DAYS_FROM_CIVIL_EPOCH_TO_UNIX_EPOCH;
}

function civilFromDays(daysSinceUnixEpoch: number): { year: number; month: number; day: number } {
  const z = daysSinceUnixEpoch + DAYS_FROM_CIVIL_EPOCH_TO_UNIX_EPOCH;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthOfMarch = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthOfMarch + 2) / 5) + 1;
  const month = monthOfMarch + (monthOfMarch < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

export function calendarDateToJulianDate<S extends TimeScale>(date: CalendarDate<S>): JulianDate<S> {
  validateCalendarDate(date);
  const days = daysFromCivil(date.year, date.month, date.day);
  const secondsOfDay = date.hour * 3600 + date.minute * 60 + date.second;
  return createJulianDate(date.scale, UNIX_EPOCH_JULIAN_DATE + days + secondsOfDay / SECONDS_PER_DAY);
}

function normalizeCalendarSeconds(secondsOfDay: number): { dayOffset: number; second: number } {
  let dayOffset = Math.floor(secondsOfDay / SECONDS_PER_DAY);
  let second = secondsOfDay - dayOffset * SECONDS_PER_DAY;
  // 浮動小数点数誤差により、正子（00:00:00）直前直後の微小値が生じうるため境界を丸める。
  if (Math.abs(second) < 1e-9) second = 0;
  if (Math.abs(second - SECONDS_PER_DAY) < 1e-9) {
    dayOffset++;
    second = 0;
  }
  return { dayOffset, second };
}

export function julianDateToCalendarDate<S extends TimeScale>(date: JulianDate<S>): CalendarDate<S> {
  assertScale(date.scale);
  assertFinite(date.value, 'Julian Date');
  const relativeDays = date.value - UNIX_EPOCH_JULIAN_DATE;
  const wholeDays = Math.floor(relativeDays);
  const seconds = (relativeDays - wholeDays) * SECONDS_PER_DAY;
  const normalized = normalizeCalendarSeconds(seconds);
  const civil = civilFromDays(wholeDays + normalized.dayOffset);
  let secondOfDay = normalized.second;
  const hour = Math.floor(secondOfDay / 3600);
  secondOfDay -= hour * 3600;
  const minute = Math.floor(secondOfDay / 60);
  secondOfDay -= minute * 60;
  // 秒未満の精度を保持しつつ、ユリウス日との相互変換での整数秒の安定性を確保する。
  const roundedSecond = Math.round(secondOfDay * 1e12) / 1e12;
  return createCalendarDate(date.scale, { ...civil, hour, minute, second: roundedSecond });
}

export function j2000EphemerisSeconds(date: JulianDate<EphemerisScale> | CalendarDate<EphemerisScale>): number {
  const jd = 'value' in date ? date : calendarDateToJulianDate(date);
  if (jd.scale !== 'TT' && jd.scale !== 'TDB') throw new RangeError('J2000 ephemeris seconds require TT or TDB');
  return (jd.value - J2000_JULIAN_DATE) * SECONDS_PER_DAY;
}

export function j2000EphemerisSecondsToJulianDate<S extends EphemerisScale>(seconds: number, scale: S): JulianDate<S> {
  assertFinite(seconds, 'J2000 ephemeris seconds');
  return createJulianDate(scale, J2000_JULIAN_DATE + seconds / SECONDS_PER_DAY);
}

function offsetSeconds(value: number, name: string): number {
  assertFinite(value, name);
  return value;
}

function utcInput(input: UtcCalendarDate | UtcJulianDate): { calendar: UtcCalendarDate; julian: UtcJulianDate } {
  const calendar = 'year' in input ? validateCalendarDate(input) : julianDateToCalendarDate(input);
  const julian = 'value' in input ? input : calendarDateToJulianDate(input);
  if (calendar.scale !== 'UTC' || julian.scale !== 'UTC') throw new RangeError('UTC input required');
  return { calendar, julian };
}

export function utcToTt(input: UtcCalendarDate | UtcJulianDate, provider: UtcOffsetProvider): TtJulianDate {
  const { calendar, julian } = utcInput(input);
  const taiMinusUtc = offsetSeconds(provider.taiMinusUtcSeconds(calendar), 'TAI-UTC offset');
  return createJulianDate('TT', julian.value + (taiMinusUtc + TT_MINUS_TAI_SECONDS) / SECONDS_PER_DAY);
}

export function ttToUtc(input: TtJulianDate, provider: UtcOffsetProvider): UtcJulianDate {
  assertScale(input.scale);
  if (input.scale !== 'TT') throw new RangeError('TT input required');
  assertFinite(input.value, 'Julian Date');

  // オフセットは UTC の関数であるため逆問題を解く。閏秒表は区分的に一定であり、
  // 数回の不動点反復で収束する。
  let utcValue = input.value - TT_MINUS_TAI_SECONDS / SECONDS_PER_DAY;
  for (let i = 0; i < 4; i++) {
    const utc = julianDateToCalendarDate(createJulianDate('UTC', utcValue));
    const taiMinusUtc = offsetSeconds(provider.taiMinusUtcSeconds(utc), 'TAI-UTC offset');
    utcValue = input.value - (taiMinusUtc + TT_MINUS_TAI_SECONDS) / SECONDS_PER_DAY;
  }
  return createJulianDate('UTC', utcValue);
}
