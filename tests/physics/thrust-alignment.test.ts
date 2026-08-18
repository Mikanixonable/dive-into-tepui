import * as assert from 'node:assert/strict';
import { test } from './harness';
import { resultantThrust, gimbalCorrection } from '../../src/physics/thrust-alignment';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('thrust alignment derives force, torque, and rate-limited gimbal', () => {
    const result = resultantThrust([{ position: v3(1, 0, 0), direction: v3(0, 1, 0), maxThrust: 10, gimbalRangeDeg: 5, gimbalRateDegPerSecond: 10 }], [1], v3());
    assert.deepEqual(result.force, v3(0, 10, 0));
    assert.deepEqual(result.torque, v3(0, 0, 10));
    assert.deepEqual(gimbalCorrection([{ position: v3(), direction: v3(0, 0, 1), maxThrust: 1, gimbalRangeDeg: 5, gimbalRateDegPerSecond: 10 }], [20], 0.2), [2]);
  });
}
