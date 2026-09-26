import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AtmosphericWindField, CloudPatternTransport } from '../../src/render/cloud/atmospheric-wind';
import { atmosphericWindAt } from '../../src/render/cloud/atmospheric-wind-sample';

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

  test('atmospheric wind: 分離した純粋関数は sample と同じ値を返す', () => {
    const field = new AtmosphericWindField();
    for (const latitude of [-1.2, -0.5, 0, 0.35, 0.6, 1.4]) {
      for (const height of [0, 1_000, 5_500, 10_000, 20_000]) {
        assert.deepEqual(field.sample(latitude, height), atmosphericWindAt(latitude, height));
      }
    }
  });
}
