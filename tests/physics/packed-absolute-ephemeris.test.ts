import * as assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { test } from './harness';
import {
  buildEphemerisPackData, encodeEphemerisPack, encodeFloat64Payload,
} from '../../src/physics/ephemeris-pack/format';
import {
  PackedAbsoluteEphemeris, loadPackedAbsoluteEphemeris,
} from '../../src/physics/packed-absolute-ephemeris';
import { J2000_JULIAN_DATE } from '../../src/physics/time';

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
  test('packed absolute ephemeris: J2000 ET packをJD_TDBで評価する', () => {
    const source = PackedAbsoluteEphemeris.fromTrustedBytes(fixture());
    assert.ok(source.hasBody('earth'));
    assert.deepEqual(source.barycentricStateOf('earth', J2000_JULIAN_DATE).r, { x: 1, y: 2, z: 3 });
    assert.equal(source.validStartJdTdb, J2000_JULIAN_DATE);
  });

  test('packed absolute ephemeris: browser loaderはpayload改竄を拒否する', async () => {
    if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
    await assert.rejects(loadPackedAbsoluteEphemeris(fixture(true)), /SHA-256不一致/);
  });
}
