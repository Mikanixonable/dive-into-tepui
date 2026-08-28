import * as assert from 'node:assert/strict';
import {
  J2000_JULIAN_DATE,
  calendarDateToJulianDate,
  createCalendarDate,
  ephemerisSecondsToJulianDate,
  isGregorianLeapYear,
  j2000EphemerisSeconds,
  julianDateToCalendarDate,
  parseCalendarDate,
  ttToUtc,
  utcToTt,
  validateCalendarDate,
} from '../../src/physics/time';
import { test } from '../harness';

export function register(): void {
  test('astronomical time: canonical TDB date has the pinned JD and J2000 ET', () => {
    const date = parseCalendarDate('20115-05-14T06:00:00', 'TDB');
    const jd = calendarDateToJulianDate(date);

    assert.equal(jd.value, 9068045.75);
    assert.equal(jd.scale, 'TDB');
    assert.equal(j2000EphemerisSeconds(date), 571665664800);
  });

  test('astronomical time: five-digit Gregorian dates round-trip without Date', () => {
    const date = createCalendarDate('TDB', {
      year: 100000,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
      second: 12.25,
    });
    const roundTrip = julianDateToCalendarDate(calendarDateToJulianDate(date));
    assert.deepEqual({ ...roundTrip, second: 0 }, { ...date, second: 0 });
    assert.ok(Math.abs(roundTrip.second - date.second) < 1e-3, `fractional-second round-trip error: ${roundTrip.second - date.second}`);
    const fromSeconds = julianDateToCalendarDate(ephemerisSecondsToJulianDate(j2000EphemerisSeconds(date), 'TDB'));
    assert.deepEqual({ ...fromSeconds, second: 0 }, { ...date, second: 0 });
    assert.ok(Math.abs(fromSeconds.second - date.second) < 1e-3, `ET fractional-second round-trip error: ${fromSeconds.second - date.second}`);
  });

  test('astronomical time: Gregorian leap-year rules include century and year zero cases', () => {
    assert.equal(isGregorianLeapYear(2000), true);
    assert.equal(isGregorianLeapYear(1900), false);
    assert.equal(isGregorianLeapYear(2004), true);
    assert.equal(isGregorianLeapYear(0), true);
    assert.equal(isGregorianLeapYear(-100), false);

    assert.doesNotThrow(() => validateCalendarDate({ year: 2000, month: 2, day: 29, hour: 0, minute: 0, second: 0, scale: 'TDB' }));
    assert.throws(() => validateCalendarDate({ year: 1900, month: 2, day: 29, hour: 0, minute: 0, second: 0, scale: 'TDB' }), RangeError);
    assert.throws(() => validateCalendarDate({ year: 2001, month: 4, day: 31, hour: 0, minute: 0, second: 0, scale: 'TDB' }), RangeError);
  });

  test('astronomical time: J2000 is noon on 2000-01-01 in TT/TDB', () => {
    const date = createCalendarDate('TDB', { year: 2000, month: 1, day: 1, hour: 12, minute: 0, second: 0 });
    assert.equal(calendarDateToJulianDate(date).value, J2000_JULIAN_DATE);
    assert.equal(j2000EphemerisSeconds(date), 0);
  });

  test('astronomical time: UTC conversion uses the injected offset provider', () => {
    const utc = createCalendarDate('UTC', { year: 20350, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
    const provider = {
      taiMinusUtcSeconds: () => 42,
      tdbMinusTtSeconds: () => 0,
    };
    const tt = utcToTt(utc, provider);
    const expected = calendarDateToJulianDate(utc).value + (42 + 32.184) / 86400;
    assert.equal(tt.value, expected);
    assert.ok(Math.abs(ttToUtc(tt, provider).value - calendarDateToJulianDate(utc).value) < 1e-12);
    assert.throws(() => j2000EphemerisSeconds(calendarDateToJulianDate(utc) as never), RangeError);
  });

  test('astronomical time: Z suffix is UTC-only and leap seconds are outside the base mapping', () => {
    assert.deepEqual(parseCalendarDate('2024-01-01T00:00:00Z', 'UTC'), createCalendarDate('UTC', {
      year: 2024,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    }));
    assert.throws(() => parseCalendarDate('2024-01-01T00:00:00Z', 'TT'), RangeError);
    assert.throws(() => parseCalendarDate('2024-01-01T00:00:00Z', 'TDB'), RangeError);
    assert.throws(() => parseCalendarDate('2016-12-31T23:59:60', 'UTC'), RangeError);
  });
}
