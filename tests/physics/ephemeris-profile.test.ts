import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  EPHEMERIS_PROFILES, UnsupportedEphemerisEpochError, profileAt,
} from '../../src/physics/ephemeris-profile';
import { createJulianDate, ephemerisSeconds, J2000_JULIAN_DATE, SECONDS_PER_DAY } from '../../src/physics/time';

export function register(): void {
  test('ephemeris profile: 現代と西暦20000年付近を別の根拠データへ割り当てる', () => {
    assert.equal(profileAt(2461041.5).id, 'modern-de440');
    assert.equal(profileAt(9068045.75).id, 'far-future-20000');
  });

  test('ephemeris profile: 指定プロファイルの期間外と未対応年代を拒否する', () => {
    assert.throws(() => profileAt(2451545, 'far-future-20000'), UnsupportedEphemerisEpochError);
    assert.throws(() => profileAt(4000000), UnsupportedEphemerisEpochError);
    assert.throws(() => profileAt(2464694.01), UnsupportedEphemerisEpochError);
    assert.throws(() => profileAt(NaN), TypeError);
  });

  test('ephemeris profile: 高精度中心期間は有効期間に包含される', () => {
    for (const profile of Object.values(EPHEMERIS_PROFILES)) {
      assert.ok(profile.validStartJdTdb <= profile.highAccuracyStartJdTdb);
      assert.ok(profile.highAccuracyStartJdTdb <= profile.highAccuracyEndJdTdb);
      assert.ok(profile.highAccuracyEndJdTdb <= profile.validEndJdTdb);
    }
  });

  // loadAbsoluteEphemeris は「pack が要求期間を覆うか」を pack 自身の時刻軸(J2000 ET 秒)で
  // 比べる。**元期起点の simTime へ寄せてから比べてはならない** — 要求側と pack 側で減算の
  // 順序が変わり、期間の内側にある元期が数 µs のずれで弾かれる。
  test('ephemeris-profile: 期間内のどの元期でも pack の被覆判定が通る', () => {
    for (const profile of Object.values(EPHEMERIS_PROFILES)) {
      const span = profile.validEndJdTdb - profile.validStartJdTdb;
      const packStartEt = (profile.validStartJdTdb - J2000_JULIAN_DATE) * SECONDS_PER_DAY;
      const packEndEt = (profile.validEndJdTdb - J2000_JULIAN_DATE) * SECONDS_PER_DAY;
      for (const frac of [0, 1e-4, 0.001, 0.0338, 0.2739, 0.5, 0.9999, 1]) {
        const epoch = createJulianDate('TDB', profile.validStartJdTdb + span * frac);
        const requestedStartEt = ephemerisSeconds(epoch);
        const requestedEndEt = (profile.validEndJdTdb - J2000_JULIAN_DATE) * SECONDS_PER_DAY;
        const where = `${profile.id} frac=${frac}`;
        assert.ok(requestedStartEt >= packStartEt, `${where}: 元期が pack の開始より前と判定された`);
        assert.ok(requestedEndEt <= packEndEt, `${where}: 要求終端が pack の終端を超えると判定された`);
      }
    }
  });
}
