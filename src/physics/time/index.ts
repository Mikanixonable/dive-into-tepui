/**
 * Pure astronomical time primitives.
 *
 * Calendar years use astronomical year numbering (year 0 is 1 BCE) and the
 * Gregorian rules are extended in both directions.  This deliberately does
 * not use JavaScript Date: Date has implementation-dependent behaviour for
 * years outside its usual four-digit range and cannot represent TDB.
 *
 * The base CalendarDate/JD mapping is a uniform 86400-second-day mapping. It
 * therefore does not represent a literal UTC 23:59:60 leap second. Code that
 * needs literal leap seconds must supply them through a SPICE/offset adapter;
 * this module does not claim complete UTC leap-second support.
 */

export type TimeScale = 'UTC' | 'TT' | 'TDB';
export type EphemerisScale = 'TT' | 'TDB';

export interface CalendarFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type CalendarDate<S extends TimeScale = TimeScale> = CalendarFields & { readonly scale: S };
export type UtcCalendarDate = CalendarDate<'UTC'>;
export type TtCalendarDate = CalendarDate<'TT'>;
export type TdbCalendarDate = CalendarDate<'TDB'>;

export interface JulianDate<S extends TimeScale = TimeScale> {
  readonly value: number;
  readonly scale: S;
}

export type UtcJulianDate = JulianDate<'UTC'>;
export type TtJulianDate = JulianDate<'TT'>;
export type TdbJulianDate = JulianDate<'TDB'>;

/**
 * The caller supplies the changing UTC definition.  In particular, there is
 * intentionally no built-in leap-second table: a future UTC instant cannot
 * be converted correctly until that information exists.
 */
export interface UtcOffsetProvider {
  /** TAI - UTC, in seconds, at the supplied UTC calendar instant. */
  taiMinusUtcSeconds(utc: UtcCalendarDate): number;
}

/** TDB - TT, in seconds, supplied by an ephemeris/time-scale implementation. */
export interface TdbOffsetProvider {
  tdbMinusTtSeconds(tt: TtJulianDate): number;
}

export type AstronomicalTimeOffsetProvider = UtcOffsetProvider & TdbOffsetProvider;

export const TT_MINUS_TAI_SECONDS = 32.184;
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

export function daysInMonth(year: number, month: number): number {
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

/** Alias with the argument order commonly used by call sites. */
export const calendarDate = createCalendarDate;

export function createJulianDate<S extends TimeScale>(scale: S, value: number): JulianDate<S> {
  assertScale(scale);
  assertFinite(value, 'Julian Date');
  return { value, scale };
}

/** Parse an ISO-like extended-year calendar timestamp with an explicit scale. */
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

/**
 * Days since 1970-01-01 in the proleptic Gregorian calendar.
 * This is the integer-arithmetic algorithm of Howard Hinnant, extended to
 * astronomical year numbering by allowing signed years.
 */
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
  // A JD is a binary floating-point number, so an exact midnight can arrive
  // just below or above the boundary after subtraction.
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
  // Keep meaningful sub-second input while making ordinary integral seconds
  // stable under a JD round trip.
  const roundedSecond = Math.round(secondOfDay * 1e12) / 1e12;
  return createCalendarDate(date.scale, { ...civil, hour, minute, second: roundedSecond });
}

export function j2000EphemerisSeconds(date: JulianDate<EphemerisScale> | CalendarDate<EphemerisScale>): number {
  const jd = 'value' in date ? date : calendarDateToJulianDate(date);
  if (jd.scale !== 'TT' && jd.scale !== 'TDB') throw new RangeError('J2000 ephemeris seconds require TT or TDB');
  return (jd.value - J2000_JULIAN_DATE) * SECONDS_PER_DAY;
}

/** Short name for the J2000-relative ephemeris-time quantity. */
export const ephemerisSeconds = j2000EphemerisSeconds;
export const j2000Seconds = j2000EphemerisSeconds;

export function ephemerisSecondsToJulianDate<S extends EphemerisScale>(seconds: number, scale: S): JulianDate<S> {
  assertFinite(seconds, 'J2000 ephemeris seconds');
  return createJulianDate(scale, J2000_JULIAN_DATE + seconds / SECONDS_PER_DAY);
}

export function ephemerisSecondsToCalendarDate<S extends EphemerisScale>(seconds: number, scale: S): CalendarDate<S> {
  return julianDateToCalendarDate(ephemerisSecondsToJulianDate(seconds, scale));
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

  // The offset is a function of UTC, so solve the inverse at a UTC date. A
  // leap-second table is piecewise constant; a few fixed-point iterations are
  // enough and keep the provider responsible for all UTC knowledge.
  let utcValue = input.value - TT_MINUS_TAI_SECONDS / SECONDS_PER_DAY;
  for (let i = 0; i < 4; i++) {
    const utc = julianDateToCalendarDate(createJulianDate('UTC', utcValue));
    const taiMinusUtc = offsetSeconds(provider.taiMinusUtcSeconds(utc), 'TAI-UTC offset');
    utcValue = input.value - (taiMinusUtc + TT_MINUS_TAI_SECONDS) / SECONDS_PER_DAY;
  }
  return createJulianDate('UTC', utcValue);
}

export function ttToTdb(input: TtJulianDate, provider: TdbOffsetProvider): TdbJulianDate {
  assertScale(input.scale);
  if (input.scale !== 'TT') throw new RangeError('TT input required');
  assertFinite(input.value, 'Julian Date');
  const delta = offsetSeconds(provider.tdbMinusTtSeconds(input), 'TDB-TT offset');
  return createJulianDate('TDB', input.value + delta / SECONDS_PER_DAY);
}

export function tdbToTt(input: TdbJulianDate, provider: TdbOffsetProvider): TtJulianDate {
  assertScale(input.scale);
  if (input.scale !== 'TDB') throw new RangeError('TDB input required');
  assertFinite(input.value, 'Julian Date');
  let ttValue = input.value;
  for (let i = 0; i < 4; i++) {
    const tt = createJulianDate('TT', ttValue);
    ttValue = input.value - offsetSeconds(provider.tdbMinusTtSeconds(tt), 'TDB-TT offset') / SECONDS_PER_DAY;
  }
  return createJulianDate('TT', ttValue);
}

export function utcToTdb(input: UtcCalendarDate | UtcJulianDate, provider: AstronomicalTimeOffsetProvider): TdbJulianDate {
  return ttToTdb(utcToTt(input, provider), provider);
}

export function tdbToUtc(input: TdbJulianDate, provider: AstronomicalTimeOffsetProvider): UtcJulianDate {
  return ttToUtc(tdbToTt(input, provider), provider);
}

export function convertJulianDate(
  input: JulianDate,
  targetScale: TimeScale,
  provider?: AstronomicalTimeOffsetProvider,
): JulianDate {
  assertScale(input.scale);
  assertScale(targetScale);
  if (input.scale === targetScale) return createJulianDate(targetScale, input.value);
  if (!provider) throw new Error('a UTC/TDB offset provider is required for time-scale conversion');
  if (input.scale === 'UTC') {
    const utc = createJulianDate('UTC', input.value);
    if (targetScale === 'TT') return utcToTt(utc, provider);
    return utcToTdb(utc, provider);
  }
  if (input.scale === 'TT') {
    const tt = createJulianDate('TT', input.value);
    if (targetScale === 'UTC') return ttToUtc(tt, provider);
    return ttToTdb(tt, provider);
  }
  const tdb = createJulianDate('TDB', input.value);
  if (targetScale === 'TT') return tdbToTt(tdb, provider);
  return tdbToUtc(tdb, provider);
}

export function convertCalendarDate(
  input: CalendarDate,
  targetScale: TimeScale,
  provider?: AstronomicalTimeOffsetProvider,
): CalendarDate {
  if (input.scale === targetScale) return createCalendarDate(targetScale, input);
  return julianDateToCalendarDate(convertJulianDate(calendarDateToJulianDate(input), targetScale, provider));
}
