import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { aerobrakingStep, radiatorPerformance } from '../../src/physics/aerobraking';

export function register(): void {
  test('radiator performance distinguishes permanent shadow', () => {
    assert.ok(radiatorPerformance(40) > radiatorPerformance(300));
  });
  test('aerobraking consumes no more ablator than carried', () => {
    assert.equal(aerobrakingStep(1, 1000, 1, 1, 1, 100).ablatorConsumedKg, 1);
  });
}
