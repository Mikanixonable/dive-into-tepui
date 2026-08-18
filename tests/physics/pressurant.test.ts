import * as assert from 'node:assert/strict';
import { test } from './harness';
import { pressurantMassFor, thrustScaleFromPressure } from '../../src/physics/pressurant';

export function register(): void {
  test('helium needs less pressurant mass than nitrogen', () => {
    assert.ok(pressurantMassFor(1, 1, 'helium') < pressurantMassFor(1, 1, 'nitrogen'));
  });
  test('pressure-fed thrust scales while pump-fed remains nominal then fails', () => {
    assert.equal(thrustScaleFromPressure(0.5, 1, 'pressure_fed'), 0.5);
    assert.equal(thrustScaleFromPressure(0.5, 1, 'pump_fed'), 0);
  });
}
