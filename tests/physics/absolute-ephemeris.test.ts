import { orbitingMotionOf, solarSystemParts, stateOf, TEST_EPOCH } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  AbsoluteEphemeris, MissingEphemerisBodyError, HelioEphemeris, icrfToGameEci,
} from '../../src/physics/absolute-ephemeris';
import { v3 } from '../../src/math/vec3';

export function register(): void {
  // 恒星を重心に固定した源。ECI 化の減算だけを検査対象にするため、恒星のずれは別の源で見る。
  const source: AbsoluteEphemeris = {
    validStartSimTime: 0,
    validEndSimTime: 86400,
    hasBody: (id) => id === 'sun' || id === 'earth' || id === 'moon',
    barycentricStateOf: (id, t) => {
      if (id === 'sun') return { r: v3(0, 0, 0), v: v3(0, 0, 0) };
      return id === 'earth'
        ? { r: v3(t, 2 * t, 3 * t), v: v3(1, 2, 3) }
        : { r: v3(t + 10, 2 * t + 20, 3 * t + 30), v: v3(4, 6, 8) };
    },
  };

  test('absolute ephemeris: ICRF Z極をゲームECI Y極へ右手系で写す', () => {
    assert.deepEqual(icrfToGameEci(v3(1, 2, 3)), v3(1, 3, -2));
  });

  test('absolute ephemeris: 恒星を厳密な原点にし位置・速度を同じ変換へ通す', () => {
    const eph = new HelioEphemeris(source, 'sun');
    assert.deepEqual(eph.stateOf('sun', 150).r, v3());
    const earth = eph.stateOf('earth', 150);
    assert.deepEqual(earth.r, icrfToGameEci(v3(150, 300, 450)));
    assert.deepEqual(earth.v, icrfToGameEci(v3(1, 2, 3)));
    assert.equal(earth.t, 150);
  });

  test('absolute ephemeris: 恒星の重心位置を引いてから答える', () => {
    const offsetStar: AbsoluteEphemeris = {
      validStartSimTime: 0,
      validEndSimTime: 86400,
      hasBody: (id) => id === 'sun' || id === 'earth',
      barycentricStateOf: (id) => id === 'sun'
        ? { r: v3(1, 2, 3), v: v3(4, 5, 6) }
        : { r: v3(11, 22, 33), v: v3(44, 55, 66) },
    };
    const earth = new HelioEphemeris(offsetStar, 'sun').stateOf('earth', 0);
    assert.deepEqual(earth.r, icrfToGameEci(v3(10, 20, 30)));
    assert.deepEqual(earth.v, icrfToGameEci(v3(40, 50, 60)));
  });

  test('absolute ephemeris: 未収録天体を暗黙フォールバックしない', () => {
    const eph = new HelioEphemeris(source, 'sun');
    assert.throws(() => eph.stateOf('mars', 0), MissingEphemerisBodyError);
    assert.throws(() => new HelioEphemeris(source, 'mars'), MissingEphemerisBodyError);
  });

  test('absolute ephemeris: 天体の運動は収録天体の位置・速度・軌道法線を高精度経路へ統一する', () => {
    const parts = solarSystemParts({}, TEST_EPOCH, source);
    const moonMotion = orbitingMotionOf(parts, 'moon');
    const moon = stateOf(parts, 'moon', 3600);
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
