// shadow.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { sunlitFactor } from '../../src/physics/shadow';
import { R_EARTH } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('shadow: sunlitFactor は太陽側で常に 1', () => {
    const sunDir = v3(1, 0, 0);
    for (const r of [v3(1e6, 0, 0), v3(0, R_EARTH, 0), v3(-1e5, 7e6, 0)]) {
      assert.equal(sunlitFactor(r, sunDir, 1e5), 1, `r=${JSON.stringify(r)}`);
    }
  });

  test('shadow: sunlitFactor は影の中心軸上(地球半径より内側)で 0', () => {
    const sunDir = v3(1, 0, 0);
    const r = v3(-R_EARTH * 0.5, 0, 0); // 反太陽側かつ軸上
    assert.equal(sunlitFactor(r, sunDir, 1e5), 0);
  });

  test('shadow: sunlitFactor は影の縁で 0..1 の間になり、軸から離れるほど単調増加する', () => {
    const sunDir = v3(1, 0, 0);
    const penumbra = 1e5;
    const along = -1e6; // 反太陽側
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const perp = R_EARTH + (i / 10) * penumbra;
      const r = v3(along, perp, 0);
      const lit = sunlitFactor(r, sunDir, penumbra);
      assert.ok(lit >= 0 && lit <= 1, `範囲外 (i=${i}): ${lit}`);
      assert.ok(lit >= prev, `単調増加でない (i=${i}): ${lit} < ${prev}`);
      prev = lit;
    }
    assert.ok(prev > 0, '縁の外側で 0 のまま');
  });

  test('shadow: sunlitFactor は常に 0..1 に収まる', () => {
    const sunDir = v3(0.3, 0.5, -0.8);
    const n = Math.hypot(sunDir.x, sunDir.y, sunDir.z);
    const dir = v3(sunDir.x / n, sunDir.y / n, sunDir.z / n);
    for (let i = 0; i < 20; i++) {
      const r = v3((i - 10) * 5e5, (i * 7 - 3) * 3e5, (i * i - 50) * 1e5);
      const lit = sunlitFactor(r, dir, 1e5);
      assert.ok(lit >= 0 && lit <= 1, `範囲外: ${lit}`);
    }
  });
}
