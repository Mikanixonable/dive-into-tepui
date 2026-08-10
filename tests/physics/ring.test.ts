// solar-system.ts の環データの妥当性の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { SOLAR_SYSTEM } from '../../src/physics/solar-system';

export function register(): void {
  const ringBodies = ['jupiter', 'saturn', 'uranus', 'neptune'] as const;

  test('環データ: 登録した全惑星が rings を持ち、全帯で内径 < 外径・厚み >= 0', () => {
    for (const id of ringBodies) {
      const def = SOLAR_SYSTEM[id];
      assert.equal(def.kind, 'planet');
      const rings = def.kind === 'planet' ? def.rings : undefined;
      assert.ok(rings !== undefined, `${id} に rings が無い`);
      assert.ok(rings!.bands.length > 0, `${id} の帯数が 0`);
      for (const band of rings!.bands) {
        assert.ok(band.innerRadius < band.outerRadius, `${id}: innerRadius >= outerRadius (${band.innerRadius}, ${band.outerRadius})`);
        assert.ok(band.thickness >= 0, `${id}: thickness が負`);
      }
    }
  });

  test('環データ: 土星は D〜A 環にテクスチャ識別子を持ち、他の帯は持たない', () => {
    const def = SOLAR_SYSTEM.saturn;
    assert.equal(def.kind, 'planet');
    const rings = def.kind === 'planet' ? def.rings : undefined;
    assert.ok(rings !== undefined);
    const textured = rings!.bands.filter((b) => b.texture !== undefined);
    assert.equal(textured.length, 1);
    assert.equal(textured[0]!.texture, 'saturn');
  });

  test('環データ: 木星のハロー環・ゴサマー環2本と土星 E 環は厚みを持つ(扁平トーラス)', () => {
    const jupiter = SOLAR_SYSTEM.jupiter;
    assert.equal(jupiter.kind, 'planet');
    const jRings = jupiter.kind === 'planet' ? jupiter.rings : undefined;
    assert.ok(jRings !== undefined);
    const thickBands = jRings!.bands.filter((b) => b.thickness > 0);
    assert.equal(thickBands.length, 3, 'ハロー環+ゴサマー環2本のはずが違う');

    const saturn = SOLAR_SYSTEM.saturn;
    assert.equal(saturn.kind, 'planet');
    const sRings = saturn.kind === 'planet' ? saturn.rings : undefined;
    assert.ok(sRings !== undefined);
    const eRing = sRings!.bands.find((b) => b.innerRadius > 1.7e8 && b.innerRadius < 1.9e8);
    assert.ok(eRing !== undefined, 'E 環が見つからない');
    assert.ok(eRing!.thickness > 0, 'E 環が扁平になっている');
  });

  test('環データ: 海王星アダムス環だけが5本のアークを持つ', () => {
    const def = SOLAR_SYSTEM.neptune;
    assert.equal(def.kind, 'planet');
    const rings = def.kind === 'planet' ? def.rings : undefined;
    assert.ok(rings !== undefined);
    const withArcs = rings!.bands.filter((b) => b.arcs !== undefined);
    assert.equal(withArcs.length, 1);
    assert.equal(withArcs[0]!.arcs!.length, 5);
    for (const arc of withArcs[0]!.arcs!) {
      assert.ok(arc.fromDeg >= 0 && arc.fromDeg < 360);
      assert.ok(arc.toDeg > arc.fromDeg);
    }
  });

  test('環データ: 天王星は13本の帯を持ち、いずれも土星本体より遥かに小さい半径に収まる', () => {
    const def = SOLAR_SYSTEM.uranus;
    assert.equal(def.kind, 'planet');
    const rings = def.kind === 'planet' ? def.rings : undefined;
    assert.ok(rings !== undefined);
    assert.equal(rings!.bands.length, 13);
    for (const band of rings!.bands) {
      assert.ok(band.outerRadius < 2e8, `天王星の環にしては半径が大きすぎる: ${band.outerRadius}`);
    }
  });

  test('環データ: 土星フェーベ環は土星本体より3桁大きい半径に登録されている', () => {
    const def = SOLAR_SYSTEM.saturn;
    assert.equal(def.kind, 'planet');
    const rings = def.kind === 'planet' ? def.rings : undefined;
    assert.ok(rings !== undefined);
    const phoebe = rings!.bands.find((b) => b.innerRadius > 1e9);
    assert.ok(phoebe !== undefined, 'フェーベ環が見つからない');
    assert.ok(phoebe!.outerRadius / def.radius > 100, 'フェーベ環が土星本体に対して十分大きくない');
  });
}
