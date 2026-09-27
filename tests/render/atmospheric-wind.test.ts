import * as assert from 'node:assert/strict';
import { float } from 'three/tsl';
import { test } from '../harness';
import { AtmosphericWindField, CloudPatternTransport } from '../../src/render/cloud/atmospheric-wind';
import { evaluateShaderNode } from './tsl-node-evaluator';

// 模様を載せる天体の半径 [m]。角位相は半径で割って出るので、値そのものは判定に効かない。
const SURFACE_RADIUS = 6.371e6;

export function register(): void {
  test('atmospheric wind: vertical shear is continuous and altitude dependent', () => {
    const field = new AtmosphericWindField();
    const surface = field.sample(45 * Math.PI / 180, 1_000);
    const upper = field.sample(45 * Math.PI / 180, 10_000);
    assert.ok(upper.east > surface.east);
    const near = field.sample(45 * Math.PI / 180, 9_999);
    assert.ok(Math.abs(upper.east - near.east) < 0.01);
  });

  test('atmospheric wind: meridional wind is continuous across the equator', () => {
    const field = new AtmosphericWindField();
    // 赤道無風帯では上層の子午線風が南北半球の係数だけで決まるので、緯度 0 で跳んではいけない
    // (SPEC「緯度に沿った継ぎ目がどこにも立たない」)。
    for (const height of [1_000, 5_500, 10_000]) {
      const south = field.sample(-1e-6, height).north;
      const north = field.sample(1e-6, height).north;
      assert.ok(Math.abs(north - south) < 1e-3);
    }
    // 赤道では係数は 0 で、転移幅の外では ±1 に飽和する — 赤道の向流と ±15° の帯の値。
    assert.ok(Math.abs(field.sample(0, 10_000).north) < 1e-12);
    assert.ok(Math.abs(field.sample(0.09, 10_000).north + 0.8) < 1e-12);
    assert.ok(Math.abs(field.sample(-0.09, 10_000).north - 0.8) < 1e-12);
  });

  test('atmospheric wind: sampleNode agrees with the CPU sample', () => {
    const field = new AtmosphericWindField();
    for (const height of [1_000, 5_500, 10_000]) {
      for (const degrees of [-75, -45, -15, -5, -0.1, 0, 0.1, 5, 15, 45, 75]) {
        const latitude = degrees * Math.PI / 180;
        const node = evaluateShaderNode(field.sampleNode(float(latitude), height)) as number[];
        const wind = field.sample(latitude, height);
        assert.ok(Math.abs(node[0]! - wind.east) < 1e-9, `east at ${degrees}°, ${height} m`);
        assert.ok(Math.abs(node[1]! - wind.north) < 1e-9, `north at ${degrees}°, ${height} m`);
      }
    }
  });

  test('cloud pattern transport: phase is deterministic and does not alter physical wind', () => {
    const field = new AtmosphericWindField();
    const transport = new CloudPatternTransport(SURFACE_RADIUS, field);
    assert.equal(transport.phaseAt(0.4, 1_000, 3600), transport.phaseAt(0.4, 1_000, 3600));
    assert.deepEqual(field.sample(0.4, 1_000), field.sample(0.4, 1_000));
  });

  test('cloud pattern transport: m/s phase conversion scales with elapsed time', () => {
    const transport = new CloudPatternTransport(SURFACE_RADIUS);
    const oneDay = transport.angularPhase(10, 0, 0, 86400).east;
    const twoDays = transport.angularPhase(10, 0, 0, 2 * 86400).east;
    assert.ok(oneDay > 0);
    assert.ok(Math.abs(twoDays - 2 * oneDay) < 1e-12);
  });
}
