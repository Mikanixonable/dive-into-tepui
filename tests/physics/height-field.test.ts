import * as assert from 'node:assert/strict';
import { test } from './harness';
import { heightAt, normalAt, surfacePointAt } from '../../src/physics/terrain/height-field';
import { dot, len } from '../../src/physics/vec3';

export function register(): void {
  test('height field is deterministic and finite', () => {
    assert.equal(heightAt('moon', -1.4, 0.2), heightAt('moon', -1.4, 0.2));
    assert.ok(Number.isFinite(heightAt('moon', 0, 0)));
  });
  test('surface normal is unit and points outward', () => {
    const p = surfacePointAt('moon', -1.2, 0.4);
    const n = normalAt('moon', -1.2, 0.4);
    assert.ok(Math.abs(len(n) - 1) < 1e-6);
    assert.ok(dot(p, n) > 0);
  });
}
