import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { evaluateLanding, updateLandingState } from '../../src/physics/landing';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('landing requires three safe contacts', () => {
    const legs = [1, 2, 3].map((id) => ({ id: String(id), foot: v3(), stroke: 1, safeVerticalSpeed: 2, safeHorizontalSpeed: 2, maxTiltRad: 0.2, retractable: true }));
    const contacts = legs.map((leg) => ({ legId: leg.id, penetration: 0, normal: v3(0, 1, 0), verticalSpeed: 1, horizontalSpeed: 1 }));
    assert.equal(evaluateLanding(legs, contacts, v3(0, 1, 0), v3(), 0).landed, true);
    assert.equal(evaluateLanding(legs.slice(0, 2), contacts.slice(0, 2), v3(0, 1, 0), v3(), 0).landed, false);
  });
  test('landed state releases only after thrust exceeds weight', () => {
    const state = { landed: true, armed: false, bodyId: 'moon', fixedPosition: v3() };
    assert.equal(updateLandingState(state, false, 1, 2).landed, true);
    assert.equal(updateLandingState(state, false, 3, 2).landed, false);
  });
}
