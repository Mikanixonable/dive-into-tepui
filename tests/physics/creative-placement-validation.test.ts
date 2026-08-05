import assert from 'node:assert/strict';
import { test } from './harness';
import { R_EARTH, MU_EARTH } from '../../src/physics/orbital';
import { validateEllipticPlacement } from '../../src/game/creative/placement-validation';

const base = { bodyRadius: R_EARTH, mu: MU_EARTH, sizeMode: 'apsides' as const, peAltKm: 400, apAltKm: 400, semiMajorKm: 6771, eccentricity: 0, periodHours: 1.54, anglesDeg: [51.6, 0, 0, 0] };

test('creative placement: accepts a finite elliptic LEO form', () => assert.equal(validateEllipticPlacement(base), null));
test('creative placement: rejects NaN, hyperbolic, and surface-crossing forms', () => {
  assert.match(validateEllipticPlacement({ ...base, eccentricity: Number.NaN }) ?? '', /有限/);
  assert.match(validateEllipticPlacement({ ...base, eccentricity: 1 }) ?? '', /離心率/);
  assert.match(validateEllipticPlacement({ ...base, peAltKm: -1 }) ?? '', /近地点/);
});
