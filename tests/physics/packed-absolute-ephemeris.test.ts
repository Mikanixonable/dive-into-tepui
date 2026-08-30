import * as assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from '../harness';
import {
  buildEphemerisPackData, encodeEphemerisPack, encodeFloat64Payload,
} from '../../src/physics/ephemeris-pack/format';
import {
  PackedAbsoluteEphemeris, loadPackedAbsoluteEphemeris,
} from '../../src/physics/packed-absolute-ephemeris';
import { createJulianDate, J2000_JULIAN_DATE, SECONDS_PER_DAY } from '../../src/physics/time';

const J2000 = createJulianDate('TDB', J2000_JULIAN_DATE);

function fixture(corrupt = false): Uint8Array {
  const base = {
    format: 'tepui-ephemeris-pack' as const,
    version: 1 as const,
    frame: 'ICRF-J2000' as const,
    timeScale: 'TDB' as const,
    timeOrigin: 'J2000-ET' as const,
    positionUnit: 'm' as const,
    timeUnit: 's' as const,
    validStart: 0,
    validEnd: 10,
  };
  const data = buildEphemerisPackData(base, [{
    body: 'earth', start: 0, end: 10,
    coefficients: [[1], [2], [3]],
  }]);
  const digest = createHash('sha256').update(encodeFloat64Payload(data.payload)).digest('hex');
  const bytes = encodeEphemerisPack({ ...data.manifest, payloadSha256: digest }, data.payload);
  if (corrupt) bytes[bytes.length - 1]! ^= 1;
  return bytes;
}

export function register(): void {
  test('packed absolute ephemeris: 元期 J2000 なら pack の ET 秒がそのまま simTime になる', () => {
    const source = PackedAbsoluteEphemeris.fromTrustedBytes(fixture(), J2000);
    assert.ok(source.hasBody('earth'));
    assert.deepEqual(source.barycentricStateOf('earth', 0).r, { x: 1, y: 2, z: 3 });
    assert.equal(source.validStartSimTime, 0);
    assert.equal(source.validEndSimTime, 10);
  });

  // 構築時に元期へ寄せるので、元期をずらせば同じ pack が同じ状態を別の simTime で答える。
  // 有効期間も一緒に動く。
  test('packed absolute ephemeris: 元期をずらすと有効期間と評価時刻が同じだけ動く', () => {
    const shiftDays = 3;
    const shifted = PackedAbsoluteEphemeris.fromTrustedBytes(
      fixture(), createJulianDate('TDB', J2000_JULIAN_DATE + shiftDays));
    const shiftSec = shiftDays * SECONDS_PER_DAY;
    assert.equal(shifted.validStartSimTime, -shiftSec);
    assert.equal(shifted.validEndSimTime, 10 - shiftSec);
    assert.deepEqual(shifted.barycentricStateOf('earth', -shiftSec).r, { x: 1, y: 2, z: 3 });
  });

  test('packed absolute ephemeris: browser loaderはpayload改竄を拒否する', async () => {
    if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
    await assert.rejects(loadPackedAbsoluteEphemeris(fixture(true), J2000), /SHA-256不一致/);
  });
}
