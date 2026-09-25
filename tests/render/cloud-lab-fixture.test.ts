import * as assert from 'node:assert/strict';
import { meteorologicalFixtureImageState } from '../../tools/cloud-lab/controlled-cloud-fixture';
import { test } from '../harness';

function angularSeparation(
  a: { readonly x: number; readonly y: number; readonly z: number },
  b: { readonly x: number; readonly y: number; readonly z: number },
): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot);
}

export function register(): void {
  test('cloud lab fixture: C1 finite cloud follows spherical transport', () => {
    const start = meteorologicalFixtureImageState('C1', 0);
    const later = meteorologicalFixtureImageState('C1', 3_600);
    assert.ok(angularSeparation(start.centerA, later.centerA) > 0);
    assert.equal(later.liquidA, 0.9);
    assert.equal(later.iceA, 0);
  });

  test('cloud lab fixture: C2 lower liquid and upper ice separate under different winds', () => {
    const state = meteorologicalFixtureImageState('C2', 6 * 3_600);
    assert.ok(angularSeparation(state.centerA, state.centerB) > 0);
    assert.ok(state.liquidA > 0);
    assert.ok(state.iceB > 0);
    assert.ok(state.iceCenterB > state.topA);
  });

  test('cloud lab fixture: C3 keeps residual anvil after parent updraft decays', () => {
    const supplied = meteorologicalFixtureImageState('C3', 3_600);
    const residual = meteorologicalFixtureImageState('C3', 6 * 3_600);
    assert.ok(supplied.iceA > 0);
    assert.ok(residual.iceA > 0);
    assert.ok(residual.liquidA < supplied.liquidA);
  });

  test('cloud lab fixture: C4 dry upper air loses residual ice faster', () => {
    const state = meteorologicalFixtureImageState('C4', 6 * 3_600);
    assert.ok(state.iceA > state.iceB);
  });

  test('cloud lab fixture: C5 stronger inversion uses the shallower controlled cloud top', () => {
    const state = meteorologicalFixtureImageState('C5', 3_600);
    assert.ok(state.topA > state.topB);
  });

  test('cloud lab fixture: C6 doubled ice supply increases optical depth through closure', () => {
    const state = meteorologicalFixtureImageState('C6', 3_600);
    assert.ok(state.iceA > 0);
    assert.ok(state.iceB > state.iceA);
  });

  test('cloud lab fixture: C7 and C8 activate distinct morphology controls', () => {
    const wave = meteorologicalFixtureImageState('C7', 3_600);
    const marine = meteorologicalFixtureImageState('C8', 3_600);
    assert.equal(wave.waveStrength, 1);
    assert.equal(wave.marineStrength, 0);
    assert.equal(marine.waveStrength, 0);
    assert.equal(marine.marineStrength, 1);
  });

  test('cloud lab fixture: C9 keeps lower and upper layers spatially distinct', () => {
    const state = meteorologicalFixtureImageState('C9', 6 * 3_600);
    assert.ok(angularSeparation(state.centerA, state.centerB) > 0);
    assert.ok(state.iceCenterB - state.topA > 4_000);
  });
}
