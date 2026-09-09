import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AtmosphericWindField, CloudPatternTransport } from '../../src/render/cloud/atmospheric-wind';

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
    const transport = new CloudPatternTransport(field);
    assert.equal(transport.phaseAt(0.4, 1_000, 3600), transport.phaseAt(0.4, 1_000, 3600));
    assert.deepEqual(field.sample(0.4, 1_000), field.sample(0.4, 1_000));
  });
}
