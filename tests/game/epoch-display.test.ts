// 表示用 unix 秒への変換。作中日時ラベル(トップバー・PREDICT・目盛り)はすべてここを通る。
import assert from 'node:assert/strict';
import { epochUnixSeconds, fmtDateTime } from '../../src/game/hud/utils';
import { calendarDateToJulianDate, parseCalendarDate } from '../../src/physics/time';
import { test } from '../harness';

const epochOf = (iso: string) => calendarDateToJulianDate(parseCalendarDate(iso, 'TDB'));

export function register(): void {
  test('epoch display: 元期の日時がそのまま作中日時ラベルになる', () => {
    for (const iso of ['20115-05-14T06:00:00', '2026-01-01T00:00:00', '0500-11-30T23:59:00']) {
      assert.equal(fmtDateTime(epochUnixSeconds(epochOf(iso))), iso, iso);
    }
  });

  // Date.UTC は西暦 0〜99 年を 1900+year へ写す。開始日時は西暦0年以降を受けるので、
  // ここを素の Date.UTC で組むと 50 年開始のランが 1950 年と表示される。
  test('epoch display: 西暦 0〜99 年が 1900 年代へずれない', () => {
    assert.equal(fmtDateTime(epochUnixSeconds(epochOf('0050-01-01T00:00:00'))), '0050-01-01T00:00:00');
    assert.equal(fmtDateTime(epochUnixSeconds(epochOf('0000-01-01T00:00:00'))), '0000-01-01T00:00:00');
  });

  test('epoch display: simTime を足すとその瞬間の日時になる', () => {
    const epochUnix = epochUnixSeconds(epochOf('2026-01-01T00:00:00'));
    assert.equal(fmtDateTime(epochUnix + 86400), '2026-01-02T00:00:00');
    assert.equal(fmtDateTime(epochUnix), '2026-01-01T00:00:00');
  });
}
