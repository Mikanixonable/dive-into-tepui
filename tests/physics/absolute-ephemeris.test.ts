import {
  orbitingMotionOf, solarSystemParts, stateOf, testEphemerisSource, TEST_EPOCH,
} from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AbsoluteEphemeris, icrfToGameEci } from '../../src/physics/absolute-ephemeris';
import { v3 } from '../../src/math/vec3';

export function register(): void {
  // 恒星を重心に固定した源。ECI 化の減算だけを検査対象にするため、恒星のずれは別の源で見る。
  const source: AbsoluteEphemeris = testEphemerisSource(0, 86400, (id, t) => {
    if (id === 'sun') return { r: v3(0, 0, 0), v: v3(0, 0, 0) };
    if (id === 'earth') return { r: v3(t, 2 * t, 3 * t), v: v3(1, 2, 3) };
    if (id === 'moon') return { r: v3(t + 10, 2 * t + 20, 3 * t + 30), v: v3(4, 6, 8) };
    return null;
  });

  test('absolute ephemeris: ICRF Z極をゲームECI Y極へ右手系で写す', () => {
    assert.deepEqual(icrfToGameEci(v3(1, 2, 3)), v3(1, 3, -2));
  });

  test('absolute ephemeris: 1体ぶんの暦は重心中心のままゲーム軸で答える', () => {
    const earth = source.bodyEphemerisOf('earth');
    assert.ok(earth !== null);
    // 恒星を引かない — 原点は太陽系重心のまま。軸だけがゲーム軸へ写る。
    assert.deepEqual(earth.stateAt(150).r, icrfToGameEci(v3(150, 300, 450)));
    assert.deepEqual(earth.stateAt(150).v, icrfToGameEci(v3(1, 2, 3)));
    assert.equal(earth.stateAt(150).t, 150);
  });

  test('absolute ephemeris: 収録していない天体の切り出しは null', () => {
    assert.equal(source.bodyEphemerisOf('mars'), null);
  });

  // 恒星中心化を持たないことの検査。ECI 化は「自分 − ECI 原点天体」の差なので、恒星をどこへ
  // 置いてもその項は現れない。**恒星を引いてから差を取る実装へ戻すと、恒星の位置が丸めを
  // 通して結果へ漏れる** — この検査はその漏れを拒む。
  test('absolute ephemeris: 恒星をどこへ置いても ECI 位置は変わらない', () => {
    const withStarAt = (star: ReturnType<typeof v3>): AbsoluteEphemeris =>
      testEphemerisSource(-1e9, 1e9, (id, t) => {
        if (id === 'sun') return { r: star, v: v3(0, 0, 0) };
        if (id === 'earth') return { r: v3(1.5e11 + t, 2e6, -3e6), v: v3(1, 0, 0) };
        if (id === 'mars') return { r: v3(-2.2e11 + t, 3e6, 4e10), v: v3(1, 0, 0) };
        return null;
      });
    const atOrigin = solarSystemParts({}, TEST_EPOCH, withStarAt(v3(0, 0, 0)));
    const displaced = solarSystemParts({}, TEST_EPOCH, withStarAt(v3(7e9, -4e9, 2e9)));
    for (const t of [0, 3600, -3600]) {
      assert.deepEqual(stateOf(displaced, 'mars', t), stateOf(atOrigin, 'mars', t));
    }
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
