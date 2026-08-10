// ring-lod.ts の視角判定と、solar-system.ts の環データの妥当性の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { ringLod, ringVisualForm } from '../../src/game/celestial/ring-lod';
import { SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { henyeyGreenstein, ringArcOpticalDepth, ringPixelCoverage, ringPlanetShadow, ringTransmission } from '../../src/physics/ring-optics';

export function register(): void {
  test('ring-lod: 幅一定なら距離(metersPerPixel)の単調な関数として annulus→line の1回だけ切り替わる', () => {
    const widthMeters = 500e3; // 天王星 ε 環程度の幅
    let sawLine = false;
    let flips = 0;
    let prev: 'annulus' | 'line' | null = null;
    // metersPerPixel を対数的に増やす = カメラを遠ざけるのと等価。
    for (let i = 0; i <= 60; i++) {
      const mpp = 10 * Math.pow(10, i / 10); // 10 m/px 〜 1e7 m/px
      const form = ringVisualForm(widthMeters, mpp);
      if (form === 'line') sawLine = true;
      if (prev !== null && form !== prev) flips++;
      prev = form;
    }
    assert.equal(flips, 1, '単調性が破れている(annulus/line の切り替えが2回以上)');
    assert.ok(sawLine, '十分遠ざけても annulus のままになっている');
  });

  test('ring-lod: 閾値ちょうど(幅 = 1px)の境界で annulus 側に倒れる', () => {
    assert.equal(ringVisualForm(100, 100), 'annulus');
    assert.equal(ringVisualForm(100, 100.001), 'line');
  });

  test('ring-lod: 幅が広いほど annulus のまま保たれる距離が伸びる(同じ距離で細い方が先に線化する)', () => {
    const mpp = 5000;
    const narrow = ringVisualForm(1000, mpp);
    const wide = ringVisualForm(1e7, mpp);
    assert.equal(narrow, 'line');
    assert.equal(wide, 'annulus');
  });

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

  test('環データ: 土星主環は物理tauを持つ個別bandへ分割され、視覚alphaテクスチャに依存しない', () => {
    const def = SOLAR_SYSTEM.saturn;
    assert.equal(def.kind, 'planet');
    const rings = def.kind === 'planet' ? def.rings : undefined;
    assert.ok(rings !== undefined);
    assert.equal(rings!.bands.length, 9);
    assert.ok(rings!.bands.every((band) => band.optics.normalOpticalDepth >= 0));
    assert.ok(rings!.bands.some((band) => band.optics.normalOpticalDepth < 1e-5));
    assert.ok(rings!.bands.some((band) => band.optics.normalOpticalDepth > 1));
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

  test('ring-optics: Beer-Lambert透過と観測開き角', () => {
    assert.equal(ringTransmission(0, 1), 1);
    assert.ok(Math.abs(ringTransmission(0.4, 1) - Math.exp(-0.4)) < 1e-12);
    assert.ok(ringTransmission(0.4, 0.2) < ringTransmission(0.4, 1));
    assert.ok(ringTransmission(1e6, 1) < 1e-12);
  });

  test('ring-optics: HGと被覆率', () => {
    assert.ok(Math.abs(henyeyGreenstein(0, 0) - 1 / (4 * Math.PI)) < 1e-12);
    assert.ok(henyeyGreenstein(1, 0.8) > henyeyGreenstein(-1, 0.8));
    assert.equal(ringPixelCoverage(0, 10), 0);
    assert.equal(ringPixelCoverage(10, 100), 0.1);
    assert.equal(ringPixelCoverage(200, 100), 1);
  });

  test('ring-lod: クロスフェード中も重みを保存し、サブピクセルでは被覆率だけ減る', () => {
    const subpixel = ringLod(25, 100);
    assert.equal(subpixel.coverage, 0.25);
    assert.equal(subpixel.lineWeight, 1);
    assert.equal(subpixel.annulusWeight, 0);

    const transition = ringLod(100, 100);
    assert.ok(Math.abs(transition.lineWeight + transition.annulusWeight - 1) < 1e-12);
    assert.equal(transition.coverage, 1);
  });

  test('ring-optics: アークtau倍率は非重複の光学値として適用される', () => {
    const arcs = [{ fromDeg: 10, toDeg: 20, opticalDepthScale: 3 }];
    assert.equal(ringArcOpticalDepth(0.1, 1, 0, arcs), 0.1);
    assert.ok(Math.abs(ringArcOpticalDepth(0.1, 1, 15, arcs) - 0.3) < 1e-12);
    assert.ok(Math.abs(ringArcOpticalDepth(0.1, 2, 15, arcs) - 0.6) < 1e-12);
  });

  test('ring-optics: 惑星影は反太陽側の環だけを遮る', () => {
    const sun = { x: 1, y: 0, z: 0 };
    assert.equal(ringPlanetShadow({ x: -2, y: 0, z: 0 }, sun, 1), true);
    assert.equal(ringPlanetShadow({ x: -2, y: 2, z: 0 }, sun, 1), false);
    assert.equal(ringPlanetShadow({ x: 2, y: 0, z: 0 }, sun, 1), false);
  });
}
