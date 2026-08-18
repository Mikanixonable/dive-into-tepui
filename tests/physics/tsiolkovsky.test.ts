import * as assert from 'node:assert/strict';
import { test } from './harness';
import { burnTimeFor, dvFor, massAfterBurn, propellantForDv } from '../../src/physics/tsiolkovsky';

export function register(): void {
  test('tsiolkovsky round trips mass ratio and delta-v', () => {
    const dv = 2500;
    const prop = propellantForDv(dv, 1000, 320);
    assert.ok(Math.abs(dvFor(1000 + prop, 1000, 320) - dv) < 1e-9);
    assert.ok(Math.abs(massAfterBurn(1000 + prop, dv, 320) - 1000) < 1e-9);
    assert.ok(burnTimeFor(dv, 1000 + prop, 100000, 320) > 0);
  });
}
