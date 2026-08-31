import * as assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from '../harness';
import {
  buildPackData, encodePack, encodeFloat64Payload,
} from '../../src/physics/ephemeris/pack-format';
import {
  PackEphemeris, loadPackEphemeris,
} from '../../src/physics/ephemeris/pack';
import { EPHEMERIS_PROFILES } from '../../src/physics/ephemeris/profile';
import { icrfToGameEci } from '../../src/physics/icrf';
import { v3 } from '../../src/math/vec3';
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
  const data = buildPackData(base, [{
    body: 'earth', start: 0, end: 10,
    coefficients: [[1], [2], [3]],
  }]);
  const digest = createHash('sha256').update(encodeFloat64Payload(data.payload)).digest('hex');
  const bytes = encodePack({ ...data.manifest, payloadSha256: digest }, data.payload);
  if (corrupt) bytes[bytes.length - 1]! ^= 1;
  return bytes;
}

// 同梱 pack のファイル名。profile の id からは決まらないので、ここだけは並べて持つ。
const SHIPPED_PACKS = {
  'modern-de440': 'modern-2026-10y.epk',
  'far-future-20000': 'far-future-20115-10y.epk',
} as const;

// JPL の SPK は火星以遠の本体を持たないので、同梱 pack のこれらの系列は惑星系の重心を収録して
// いる。**宣言が欠けると 'body' と解釈され、その系がまるごと重心オフセットぶんずれる**
// (冥王星系で 2,128 km)ので、宣言そのものをここで押さえる。
const SYSTEM_BARYCENTER_BODIES = ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

export function register(): void {
  for (const [profileId, fileName] of Object.entries(SHIPPED_PACKS)) {
    test(`pack ephemeris: 同梱 pack ${fileName} は収録している点を宣言する`, () => {
      const bytes = readFileSync(resolve(process.cwd(), 'src/assets/ephemeris', fileName));
      const source = PackEphemeris.fromTrustedBytes(new Uint8Array(bytes), J2000);
      const points = source.ephemerisPoints();
      for (const id of SYSTEM_BARYCENTER_BODIES) {
        assert.equal(points.get(id)?.kind, 'systemBarycenter', `${fileName} の ${id}`);
      }
      for (const id of ['sun', 'mercury', 'venus', 'earth', 'moon']) {
        assert.equal(points.get(id)?.kind, 'body', `${fileName} の ${id}`);
      }
      // manifest を書き換えても係数は変わらないことの担保(packId は payload の digest)。
      const expected = EPHEMERIS_PROFILES[profileId as keyof typeof SHIPPED_PACKS].packId;
      assert.equal(source.payloadSha256, expected.slice(expected.lastIndexOf('@') + 1));
    });
  }

  test('pack ephemeris: 元期 J2000 なら pack の ET 秒がそのまま simTime になる', () => {
    const earth = PackEphemeris.fromTrustedBytes(fixture(), J2000)
      .ephemerisPoints().get('earth')?.ephemeris;
    assert.ok(earth !== undefined);
    assert.deepEqual(earth.baryStateAt(0).r, icrfToGameEci(v3(1, 2, 3)));
    assert.equal(earth.validStartSimTime, 0);
    assert.equal(earth.validEndSimTime, 10);
  });

  // 構築時に元期へ寄せるので、元期をずらせば同じ pack が同じ状態を別の simTime で答える。
  // 有効期間も一緒に動く。
  test('pack ephemeris: 元期をずらすと有効期間と評価時刻が同じだけ動く', () => {
    const shiftDays = 3;
    const shifted = PackEphemeris.fromTrustedBytes(
      fixture(), createJulianDate('TDB', J2000_JULIAN_DATE + shiftDays))
      .ephemerisPoints().get('earth')?.ephemeris;
    assert.ok(shifted !== undefined);
    const shiftSec = shiftDays * SECONDS_PER_DAY;
    assert.equal(shifted.validStartSimTime, -shiftSec);
    assert.equal(shifted.validEndSimTime, 10 - shiftSec);
    assert.deepEqual(shifted.baryStateAt(-shiftSec).r, icrfToGameEci(v3(1, 2, 3)));
  });

  test('pack ephemeris: 収録していない天体は一覧に載らない', () => {
    const source = PackEphemeris.fromTrustedBytes(fixture(), J2000);
    assert.equal(source.ephemerisPoints().has('mars'), false);
    assert.equal(source.ephemerisPoints().has('earth'), true);
  });

  test('pack ephemeris: browser loaderはpayload改竄を拒否する', async () => {
    if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
    await assert.rejects(loadPackEphemeris(fixture(true), J2000), /SHA-256不一致/);
  });
}
