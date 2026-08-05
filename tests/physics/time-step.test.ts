import * as assert from 'node:assert/strict';
import { adaptiveSimulationMaxStep, simulationStepDuration } from '../../src/game/simulation/time-step';
import { test } from './harness';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('time-step: known event boundary is never crossed', () => {
    assert.equal(simulationStepDuration(100, 200, 20, 107.5), 7.5);
  });

  test('time-step: frame and maximum-step boundaries still apply without an earlier event', () => {
    assert.equal(simulationStepDuration(100, 110, 20, null), 10);
    assert.equal(simulationStepDuration(100, 200, 20, 150), 20);
  });

  test('time-step: reentry boundary and just below stay on the fine step', () => {
    const state = (radius: number) => ({ r: v3(radius, 0, 0), v: v3(-100, 0, 0) });
    assert.equal(adaptiveSimulationMaxStep([state(200)], 200, 20, 1), 1);
    assert.equal(adaptiveSimulationMaxStep([state(199.999)], 200, 20, 1), 1);
  });

  test('time-step: just above reentry boundary stops exactly at it', () => {
    const state = { r: v3(201, 0, 0), v: v3(-100, 0, 0) };
    assert.ok(Math.abs(adaptiveSimulationMaxStep([state], 200, 20, 1) - 0.01) < 1e-12);
  });
}
