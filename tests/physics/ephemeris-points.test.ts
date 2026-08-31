// 暦の一覧(EphemerisPoints)を太陽系へ結んだときの経路選択の検査。
// **値そのものの正しさは主張しない** — 測るのは「どの天体がパック経路へ入り、どれが解析
// 経路へ落ちるか」と、その境界で何を混ぜないか。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { icrfToGameEci } from '../../src/physics/icrf';
import { v3 } from '../../src/math/vec3';
import {
  orbitingMotionOf, solarSystemParts, stateOf, testEphemerisPoints, TEST_EPOCH,
} from './test-helpers';

export function register(): void {
  // 恒星中心化を持たないことの検査。ECI 化は「自分 − ECI 原点天体」の差で、恒星はどちらの項
  // にも現れない。**恒星を引いてから差を取る実装では、恒星が収録されていない暦は使えなかった**
  // (供給源の構築時に例外になった)。恒星を含まない暦でパック経路が通ることがその証拠になる。
  test('ephemeris-points: 恒星が収録されていない暦でもパック経路を通る', () => {
    const withoutStar = testEphemerisPoints(-1e9, 1e9, {
      earth: (t) => ({ r: v3(1.5e11 + t, 2e6, -3e6), v: v3(1, 0, 0) }),
      mars: (t) => ({ r: v3(-2.2e11 + t, 3e6, 4e10), v: v3(1, 0, 0) }),
    });
    assert.equal(withoutStar.has('sun'), false);
    const parts = solarSystemParts({}, TEST_EPOCH, withoutStar);
    // 地球(ECI 原点)と火星はどちらもパック由来なので、その差が素の重心座標の差になる。
    assert.deepEqual(stateOf(parts, 'mars', 0).r, icrfToGameEci(v3(-2.2e11 - 1.5e11, 1e6, 4e10 + 3e6)));
    // 恒星は暦を持たないので解析経路へ落ちる。例外にならないことが要点。
    assert.ok(Number.isFinite(stateOf(parts, 'sun', 0).r.x));
  });

  // 回転基準系・軌道法線は「自分と主天体の**両方が直接収録されている**」ときだけパック由来に
  // なる。未収録の衛星は「収録済みの親 + 解析の相対」で位置を組むので、そこから親を引いた差は
  // 結局その解析の相対そのもの — パック由来と名乗る値が実は解析由来になる。
  // **この検査はその混入を拒む**(解析だけで組んだ系と一致することで示す)。
  test('ephemeris-points: 未収録の衛星の軌道法線には親からの補完を混ぜない', () => {
    const earthOnly = testEphemerisPoints(-1e9, 1e9, {
      earth: (t) => ({ r: v3(1.5e11 + t, 2e6, -3e6), v: v3(1, 0, 0) }),
    });
    const numeric = solarSystemParts({}, TEST_EPOCH, earthOnly);
    const analytic = solarSystemParts({});
    for (const t of [0, 8.64e4, 3.156e6]) {
      assert.deepEqual(
        orbitingMotionOf(numeric, 'moon').orbitNormalAt(t),
        orbitingMotionOf(analytic, 'moon').orbitNormalAt(t),
      );
    }
  });

  test('ephemeris-points: 収録天体の位置・速度・軌道法線は高精度経路へ揃う', () => {
    const source = testEphemerisPoints(0, 86400, {
      sun: () => ({ r: v3(0, 0, 0), v: v3(0, 0, 0) }),
      earth: (t) => ({ r: v3(t, 2 * t, 3 * t), v: v3(1, 2, 3) }),
      moon: (t) => ({ r: v3(t + 10, 2 * t + 20, 3 * t + 30), v: v3(4, 6, 8) }),
    });
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

  // 1体ぶんの暦は恒星を引かない — 原点は太陽系重心のまま、軸だけがゲーム軸へ写る。
  test('ephemeris-points: 切り出した暦は重心中心のままゲーム軸で答える', () => {
    const source = testEphemerisPoints(0, 86400, {
      earth: (t) => ({ r: v3(t, 2 * t, 3 * t), v: v3(1, 2, 3) }),
    });
    const earth = source.get('earth');
    assert.ok(earth !== undefined);
    assert.equal(earth.kind, 'body');
    assert.deepEqual(earth.ephemeris.stateAt(150).r, icrfToGameEci(v3(150, 300, 450)));
    assert.deepEqual(earth.ephemeris.stateAt(150).v, icrfToGameEci(v3(1, 2, 3)));
    assert.equal(earth.ephemeris.stateAt(150).t, 150);
  });
}
