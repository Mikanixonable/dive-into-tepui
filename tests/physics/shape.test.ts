// solar-system.ts の ShapeDef/shapeAxes 回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { bodyDef, shapeAxes, SOLAR_SYSTEM, SolarSystemId } from '../../src/physics/solar-system';

export function register(): void {
  test('shapeAxes: 土星の縦横比 Rp/Re = 0.902', () => {
    const def = bodyDef(SOLAR_SYSTEM, 'saturn');
    if (def.kind === 'star') throw new Error('saturn は planet のはず');
    const axes = shapeAxes(def.radius, def.shape);
    const ratio = axes.y / axes.x;
    assert.ok(Math.abs(ratio - 0.902) < 0.001, `Rp/Re = ${ratio}`);
  });

  test('shapeAxes: 木星の縦横比 Rp/Re = 0.9350', () => {
    const def = bodyDef(SOLAR_SYSTEM, 'jupiter');
    if (def.kind === 'star') throw new Error('jupiter は planet のはず');
    const axes = shapeAxes(def.radius, def.shape);
    const ratio = axes.y / axes.x;
    assert.ok(Math.abs(ratio - 0.935) < 0.0005, `Rp/Re = ${ratio}`);
  });

  test('shapeAxes: shape を持つ全天体で radius(衝突球) が3軸の最大値以上', () => {
    for (const id of Object.keys(SOLAR_SYSTEM) as SolarSystemId[]) {
      const def = bodyDef(SOLAR_SYSTEM, id);
      if (def.kind === 'star' || def.shape === undefined) continue;
      const axes = shapeAxes(def.radius, def.shape);
      const maxAxis = Math.max(axes.x, axes.y, axes.z);
      assert.ok(def.radius >= maxAxis - 1e-6, `${id}: radius=${def.radius} < max軸=${maxAxis}`);
    }
  });

  test('shapeAxes: 三軸データが §4.3 の軸比と一致する(フォボス・ケレス)', () => {
    const phobos = bodyDef(SOLAR_SYSTEM, 'phobos');
    if (phobos.kind === 'star') throw new Error('phobos は satellite のはず');
    const pAxes = shapeAxes(phobos.radius, phobos.shape);
    // 出典表: 25.90 × 22.60 × 18.32 km(直径)→ c/a = 18.32/25.90 = 0.7073
    assert.ok(Math.abs(pAxes.y / pAxes.x - 18.32 / 25.9) < 0.001);

    const ceres = bodyDef(SOLAR_SYSTEM, 'ceres');
    if (ceres.kind === 'star') throw new Error('ceres は planet のはず');
    const cAxes = shapeAxes(ceres.radius, ceres.shape);
    // 出典表: 966.2 × 962.0 × 891.8 km(直径)→ c/a = 891.8/966.2 = 0.9230
    assert.ok(Math.abs(cAxes.y / cAxes.x - 891.8 / 966.2) < 0.001);
  });

  test('shapeAxes: shape 省略時は radius による真球', () => {
    const venus = bodyDef(SOLAR_SYSTEM, 'venus');
    if (venus.kind === 'star') throw new Error('venus は planet のはず');
    assert.equal(venus.shape, undefined);
    const axes = shapeAxes(venus.radius, venus.shape);
    assert.deepEqual(axes, { x: venus.radius, y: venus.radius, z: venus.radius });
  });
}
