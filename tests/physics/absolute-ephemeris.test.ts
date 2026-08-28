import { solarSystemParts } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  AbsoluteEphemeris, MissingEphemerisBodyError, OriginCenteredEphemeris, icrfToGameEci,
} from '../../src/physics/absolute-ephemeris';
import { v3 } from '../../src/math/vec3';

export function register(): void {
  const source: AbsoluteEphemeris = {
    validStartJdTdb: 100,
    validEndJdTdb: 200,
    hasBody: (id) => id === 'earth' || id === 'moon',
    barycentricStateOf: (id, jd) => id === 'earth'
      ? { r: v3(jd, 2 * jd, 3 * jd), v: v3(1, 2, 3) }
      : { r: v3(jd + 10, 2 * jd + 20, 3 * jd + 30), v: v3(4, 6, 8) },
  };

  test('absolute ephemeris: ICRF Z極をゲームECI Y極へ右手系で写す', () => {
    assert.deepEqual(icrfToGameEci(v3(1, 2, 3)), v3(1, 3, -2));
  });

  test('absolute ephemeris: 中心天体を厳密な原点にし位置・速度を同じ変換へ通す', () => {
    const eph = new OriginCenteredEphemeris(source, 'earth', 150);
    assert.deepEqual(eph.stateOf('earth', 3600).r, v3());
    const moon = eph.stateOf('moon', 3600);
    assert.deepEqual(moon.r, v3(10, 30, -20));
    assert.deepEqual(moon.v, v3(3, 5, -4));
    assert.equal(moon.t, 3600);
  });

  test('absolute ephemeris: 未収録天体を暗黙フォールバックしない', () => {
    const eph = new OriginCenteredEphemeris(source, 'earth', 150);
    assert.throws(() => eph.stateOf('mars', 0), MissingEphemerisBodyError);
    assert.throws(() => new OriginCenteredEphemeris(source, 'mars', 150), MissingEphemerisBodyError);
  });

  test('absolute ephemeris: 天体の運動は収録天体の位置・速度・軌道法線を高精度経路へ統一する', () => {
    const moonMotion = solarSystemParts({}, 0, source, 150).motions.earthSystem.moon;
    const moon = moonMotion.stateAt(3600);
    assert.deepEqual(moon.r, v3(10, 30, -20));
    assert.deepEqual(moon.v, v3(3, 5, -4));
    const n = moonMotion.orbitNormalAt(3600);
    const h = {
      x: moon.r.y * moon.v.z - moon.r.z * moon.v.y,
      y: moon.r.z * moon.v.x - moon.r.x * moon.v.z,
      z: moon.r.x * moon.v.y - moon.r.y * moon.v.x,
    };
    const hLen = Math.hypot(h.x, h.y, h.z);
    assert.ok(Math.abs(n.x - h.x / hLen) < 1e-15);
    assert.ok(Math.abs(n.y - h.y / hLen) < 1e-15);
    assert.ok(Math.abs(n.z - h.z / hLen) < 1e-15);
  });
}
