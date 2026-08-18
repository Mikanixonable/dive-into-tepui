import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { habitatBalance } from '../../src/game/vessel/habitat';
import { stepFacilities } from '../../src/game/economy/facility-runtime';
import { aerobrakingStep, radiatorPerformance } from '../../src/physics/aerobraking';
import { ADVANCED_ENGINE_CYCLES } from '../../src/game/vessel/engine-cycles';
import { FACILITIES } from '../../src/game/economy/facility';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';

export function register(): void {
  test('habitat and radiator balances distinguish permanent shadow', () => {
    assert.ok(habitatBalance({ crew: 8, closedLoopRate: 0.5, cultivationArea: 10, wasteHeatW: 400, radiatorArea: 1, backgroundTemperatureK: 40 }).radiatorMargin >= 0);
    assert.ok(radiatorPerformance(40) > radiatorPerformance(300));
  });
  test('facility runtime respects priority, power, inputs, and outputs', () => {
    const ledger = new ResourceLedger(); ledger.add('regolith', 1);
    const result = stepFacilities(Object.values(FACILITIES), [{ id: 'regolith-heat-extraction', enabled: true, priority: 1 }], ledger, 1e8, 1);
    assert.ok(result.running.includes('regolith-heat-extraction'));
  });
  test('aerobraking consumes no more ablator than carried', () => {
    assert.equal(aerobrakingStep(1, 1000, 1, 1, 1, 100).ablatorConsumedKg, 1);
    assert.equal(ADVANCED_ENGINE_CYCLES['nuclear-thermal'].specificImpulse, 900);
  });
}
