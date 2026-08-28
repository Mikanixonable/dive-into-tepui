import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  EPHEMERIS_PROFILES, UnsupportedEphemerisEpochError, profileAt,
} from '../../src/physics/ephemeris-profile';

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
}
