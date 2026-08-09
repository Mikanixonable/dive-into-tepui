// 小惑星点群の生成が決定論的であること、カークウッドの空隙が抜けていること、
// トロヤ群が L4/L5 近傍に集まっていることの回帰テスト。
import assert from 'node:assert/strict';
import { test } from './harness';
import {
  MAIN_BELT_COUNT, TROJAN_COUNT_PER_POINT,
  allAsteroids, generateAsteroidBelt, jupiterMeanLongitude,
} from '../../src/game/celestial/asteroid-belt';
import { AU } from '../../src/physics/planet-orbit';

const DEG = Math.PI / 180;

// 角を [-π, π] へ畳む。
function wrapPi(x: number): number {
  return Math.atan2(Math.sin(x), Math.cos(x));
}

export function register(): void {
  test('asteroid-belt: the same seed produces the same field', () => {
    const a = allAsteroids(generateAsteroidBelt(12345));
    const b = allAsteroids(generateAsteroidBelt(12345));
    assert.equal(a.length, MAIN_BELT_COUNT + 2 * TROJAN_COUNT_PER_POINT);
    assert.deepEqual(a, b);
    const c = allAsteroids(generateAsteroidBelt(12346));
    assert.notDeepEqual(a, c);
  });

  test('asteroid-belt: Kirkwood gaps are depleted relative to their surroundings', () => {
    const belt = generateAsteroidBelt();
    const au = belt.mainBelt.map((el) => el.a / AU);
    for (const gap of [2.06, 2.5, 2.82, 3.28]) {
      const inGap = au.filter((x) => Math.abs(x - gap) < 0.02).length;
      const nearby = au.filter((x) => {
        const d = Math.abs(x - gap);
        return d >= 0.06 && d < 0.1;
      }).length;
      // 幅の等しい帯どうしの比較なので、点数をそのまま比べられる。
      assert.ok(inGap < nearby / 3, `gap ${gap}: ${inGap} in gap vs ${nearby} nearby`);
    }
  });

  test('asteroid-belt: trojans stay within 35 degrees of L4/L5', () => {
    const belt = generateAsteroidBelt();
    const lj = jupiterMeanLongitude(0);
    for (const [group, lead] of [[belt.trojanL4, 60], [belt.trojanL5, -60]] as const) {
      assert.equal(group.length, TROJAN_COUNT_PER_POINT);
      for (const el of group) {
        const off = wrapPi(el.l0 - lj - lead * DEG) / DEG;
        assert.ok(Math.abs(off) <= 35, `trojan offset ${off} deg from L${lead > 0 ? 4 : 5}`);
      }
    }
  });
}
