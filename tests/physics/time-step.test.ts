import * as assert from 'node:assert/strict';
import { simulationStepDuration } from '../../src/game/simulation/time-step';
import { test } from './harness';

export function register(): void {
  test('time-step: known event boundary is never crossed', () => {
    assert.equal(simulationStepDuration(100, 200, 20, 107.5), 7.5);
  });

  test('time-step: frame and maximum-step boundaries still apply without an earlier event', () => {
    assert.equal(simulationStepDuration(100, 110, 20, null), 10);
    assert.equal(simulationStepDuration(100, 200, 20, 150), 20);
  });
}
