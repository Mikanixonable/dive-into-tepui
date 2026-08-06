import * as assert from 'node:assert/strict';
import { Ephemeris } from '../../src/physics/ephemeris';
import { CENTRAL_BODIES } from '../../src/physics/central-body';
import { keplerPeriod, orbitState } from '../../src/physics/orbital';
import { add, v3 } from '../../src/physics/vec3';
import { apsisAltitudes, orbitPeriodOf, Plan } from '../../src/game/plan/plan';
import { elementsFromState } from '../../src/physics/orbital';
import { test } from './harness';

export function register(): void {
  test('plan: lunar reference uses Moon-relative state and gravitational parameter', () => {
    const ephemeris = new Ephemeris(0, 0);
    const t = 12345;
    const radius = CENTRAL_BODIES.moon.radius + 100_000;
    const relativeR = v3(radius, 0, 0);
    const relativeV = v3(0, 0, Math.sqrt(CENTRAL_BODIES.moon.mu / radius));
    const state = orbitState(
      t,
      add(ephemeris.moonPosAt(t), relativeR),
      add(ephemeris.moonVelAt(t), relativeV),
    );
    const expected = keplerPeriod(radius, CENTRAL_BODIES.moon.mu);
    assert.ok(Math.abs(orbitPeriodOf(state, 'moon', ephemeris) - expected) / expected < 1e-10);

    const plan = new Plan();
    plan.centralBody = 'moon';
    plan.trackAnchor(state);
    assert.ok(Math.abs(plan.nodeTimeRange(0, ephemeris).max - (t + expected)) < 1e-6);

    const el = elementsFromState(relativeR, relativeV, CENTRAL_BODIES.moon.mu)!;
    const apsis = apsisAltitudes(el, CENTRAL_BODIES.moon.radius);
    assert.ok(Math.abs(apsis.pe - 100_000) < 1e-6);
    assert.ok(Math.abs(apsis.ap - 100_000) < 1e-6);
  });
}
