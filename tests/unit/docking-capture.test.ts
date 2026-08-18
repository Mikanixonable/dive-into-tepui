import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { captureCheck } from '../../src/physics/docking-capture';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('docking capture reports each failed condition', () => {
    const result = captureCheck(
      { classId: 'standard', position: v3(), normal: v3(0, 0, 1), angularVelocity: v3() },
      { classId: 'large', position: v3(10, 1, 0), normal: v3(0, 0, 1), angularVelocity: v3(1, 0, 0) },
      v3(0, 0, 20),
      { maxDistance: 1, maxLateralOffset: 0.1, maxFacingAngleRad: 0.1, minApproachSpeed: 1, maxApproachSpeed: 5, maxLateralSpeed: 1, maxAngularSpeed: 0.1 },
    );
    assert.equal(result.captured, false);
    assert.ok(result.failures.includes('class') && result.failures.includes('approach-too-fast'));
  });
}
