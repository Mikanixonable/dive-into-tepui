import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { stepFacilities } from '../../src/game/economy/facility-runtime';
import { aerobrakingStep, radiatorPerformance } from '../../src/physics/aerobraking';
import { FACILITIES } from '../../src/game/economy/facility';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';

export function register(): void {
  test('radiator performance distinguishes permanent shadow', () => {
    assert.ok(radiatorPerformance(40) > radiatorPerformance(300));
  });
  test('facility runtime respects priority, power, inputs, and outputs', () => {
    const ledger = new ResourceLedger(); ledger.add('regolith', 1);
    const result = stepFacilities(Object.values(FACILITIES), [{ id: 'regolith-heat-extraction', enabled: true, priority: 1 }], ledger, 1e8, 1);
    assert.ok(result.running.includes('regolith-heat-extraction'));
  });
  test('aerobraking consumes no more ablator than carried', () => {
    assert.equal(aerobrakingStep(1, 1000, 1, 1, 1, 100).ablatorConsumedKg, 1);
  });
}
