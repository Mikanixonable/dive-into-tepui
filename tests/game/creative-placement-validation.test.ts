import assert from 'node:assert/strict';
import { test } from '../harness';
import { R_EARTH, MU_EARTH } from '../../src/physics/solar-system';
import { R_MOON, MU_MOON } from '../../src/physics/solar-system';
import {
  validateEllipticPlacementFields, validateLagrangePlacementFields, validateBaseReferenceFields,
  EllipticPlacementInput, PlacementFieldIssue,
} from '../../src/game/creative/placement-validation';

const leo = {
  centerRadius: R_EARTH, mu: MU_EARTH,
  incDeg: 51.6, raanDeg: 0, argpDeg: 0, nuDeg: 0,
  sizeMode: 'apsides', peAltKm: 400, apAltKm: 400,
} satisfies EllipticPlacementInput;
const lunar = {
  centerRadius: R_MOON, mu: MU_MOON,
  incDeg: 30, raanDeg: 45, argpDeg: 10, nuDeg: 90,
  sizeMode: 'semiMajorEcc', semiMajorKm: 2500, eccentricity: 0.1,
} satisfies EllipticPlacementInput;

function fields(issues: PlacementFieldIssue[]): string[] {
  return issues.map(i => i.field);
}
function issueFor(issues: PlacementFieldIssue[], field: string): PlacementFieldIssue | undefined {
  return issues.find(i => i.field === field);
}

export function register(): void {
  test('creative placement: accepts a finite elliptic LEO form with no issues', () => {
    assert.deepEqual(validateEllipticPlacementFields(leo), []);
  });
  test('creative placement: accepts a finite elliptic lunar-orbit form with no issues', () => {
    assert.deepEqual(validateEllipticPlacementFields(lunar), []);
  });

  test('creative placement: apsides mode flags a negative periapsis altitude on that field alone', () => {
    const issues = validateEllipticPlacementFields({ ...leo, peAltKm: -1 });
    assert.deepEqual(fields(issues), ['periapsisAltitude']);
  });
  test('creative placement: apsides mode flags an apoapsis below periapsis on the apoapsis field', () => {
    const issues = validateEllipticPlacementFields({ ...leo, peAltKm: 800, apAltKm: 400 });
    assert.deepEqual(fields(issues), ['apoapsisAltitude']);
  });
  test('creative placement: apsides mode never inspects semiMajorAxis/period/eccentricity fields', () => {
    const issues = validateEllipticPlacementFields({ ...leo, peAltKm: -1, apAltKm: -1 });
    for (const issue of issues) {
      assert.ok(!['semiMajorAxis', 'period', 'eccentricity'].includes(issue.field));
    }
  });

  test('creative placement: semiMajorEcc mode flags eccentricity >= 1 as hyperbolic', () => {
    const issues = validateEllipticPlacementFields({ ...lunar, eccentricity: 1 });
    assert.ok(issueFor(issues, 'eccentricity'));
  });
  test('creative placement: semiMajorEcc mode flags a periapsis that sinks below the body surface', () => {
    const issues = validateEllipticPlacementFields({ ...lunar, semiMajorKm: 1000, eccentricity: 0 });
    assert.ok(issueFor(issues, 'semiMajorAxis'));
  });
  test('creative placement: semiMajorEcc mode never inspects apsides/period fields', () => {
    const issues = validateEllipticPlacementFields({ ...lunar, eccentricity: 1, semiMajorKm: 1000 });
    for (const issue of issues) {
      assert.ok(!['periapsisAltitude', 'apoapsisAltitude', 'period'].includes(issue.field));
    }
  });

  test('creative placement: periodEcc mode flags an unreachable period the same way as semiMajorEcc', () => {
    const tiny: EllipticPlacementInput = { ...leo, sizeMode: 'periodEcc', periodHours: 0.001, eccentricity: 0 };
    const issues = validateEllipticPlacementFields(tiny);
    assert.ok(issueFor(issues, 'period'));
  });
  test('creative placement: periodEcc mode never inspects apsides/semiMajorAxis fields', () => {
    const bad: EllipticPlacementInput = { ...leo, sizeMode: 'periodEcc', periodHours: 0.001, eccentricity: Number.NaN };
    const issues = validateEllipticPlacementFields(bad);
    for (const issue of issues) {
      assert.ok(!['periapsisAltitude', 'apoapsisAltitude', 'semiMajorAxis'].includes(issue.field));
    }
  });

  test('creative placement: NaN angle fields are each individually flagged', () => {
    const issues = validateEllipticPlacementFields({
      ...leo, incDeg: Number.NaN, raanDeg: Number.NaN, argpDeg: 0, nuDeg: Number.NaN,
    });
    assert.deepEqual(new Set(fields(issues)), new Set(['inclination', 'raan', 'trueAnomaly']));
  });

  test('creative placement: several simultaneous problems all surface as separate issues, not just the first', () => {
    const issues = validateEllipticPlacementFields({
      ...leo, incDeg: Number.NaN, peAltKm: -5, apAltKm: -5,
    });
    const found = new Set(fields(issues));
    assert.ok(found.has('inclination'));
    assert.ok(found.has('periapsisAltitude'));
    assert.ok(issues.length >= 2);
  });
  test('creative placement: several simultaneous problems in semiMajorEcc mode all surface at once', () => {
    const issues = validateEllipticPlacementFields({
      ...lunar, incDeg: Number.NaN, eccentricity: 1, semiMajorKm: Number.NaN,
    });
    const found = new Set(fields(issues));
    assert.ok(found.has('inclination'));
    assert.ok(found.has('eccentricity'));
    assert.ok(found.has('semiMajorAxis'));
    assert.ok(issues.length >= 3);
  });

  test('creative placement: libration validation accepts a valid halo (out-of-plane only) with no issues', () => {
    assert.deepEqual(validateLagrangePlacementFields({ orbitKind: 'halo', outOfPlaneAmplitudeKm: 110000 }), []);
  });
  test('creative placement: libration validation accepts a valid lissajous with no issues', () => {
    assert.deepEqual(
      validateLagrangePlacementFields({ orbitKind: 'lissajous', inPlaneAmplitudeKm: 200000, outOfPlaneAmplitudeKm: 110000 }),
      [],
    );
  });
  test('creative placement: halo ignores in-plane amplitude entirely, only out-of-plane is checked', () => {
    // ハローは面外振幅から三次拘束で面内振幅が決まるため、面内振幅フィールド自体が入力に存在しない。
    const issues = validateLagrangePlacementFields({ orbitKind: 'halo', outOfPlaneAmplitudeKm: -1 });
    assert.deepEqual(fields(issues), ['outOfPlaneAmplitude']);
  });
  test('creative placement: lissajous flags a non-positive in-plane amplitude on that field alone', () => {
    const issues = validateLagrangePlacementFields({ orbitKind: 'lissajous', inPlaneAmplitudeKm: 0, outOfPlaneAmplitudeKm: 110000 });
    assert.deepEqual(fields(issues), ['inPlaneAmplitude']);
  });
  test('creative placement: lissajous flags both amplitudes at once when both are invalid', () => {
    const issues = validateLagrangePlacementFields({ orbitKind: 'lissajous', inPlaneAmplitudeKm: Number.NaN, outOfPlaneAmplitudeKm: -5 });
    assert.deepEqual(new Set(fields(issues)), new Set(['inPlaneAmplitude', 'outOfPlaneAmplitude']));
  });

  test('creative placement: base rejects an earth/jupiter elements reference on the referenceBody field', () => {
    assert.deepEqual(fields(validateBaseReferenceFields('base', 'elements', 'earth')), ['referenceCelestialBody']);
    assert.deepEqual(fields(validateBaseReferenceFields('base', 'elements', 'jupiter')), ['referenceCelestialBody']);
  });
  test('creative placement: base accepts a moon-elements reference and any libration reference', () => {
    assert.deepEqual(validateBaseReferenceFields('base', 'elements', 'moon'), []);
    assert.deepEqual(validateBaseReferenceFields('base', 'lagrange', 'earth'), []);
    assert.deepEqual(validateBaseReferenceFields('base', 'lagrange', undefined), []);
  });
  test('creative placement: non-base object types are never restricted regardless of reference body', () => {
    assert.deepEqual(validateBaseReferenceFields('player', 'elements', 'earth'), []);
    assert.deepEqual(validateBaseReferenceFields('enemy', 'elements', 'jupiter'), []);
    assert.deepEqual(validateBaseReferenceFields('ammo', 'elements', 'earth'), []);
  });
}
