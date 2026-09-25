import * as assert from 'node:assert/strict';
import { cloudLifecycleAt } from '../../src/game/cloud/cloud-lifecycle';
import { test } from '../harness';

export function register(): void {
  test('cloud lifecycle: parent updraft decays before humid anvil residue disappears', () => {
    const active = cloudLifecycleAt({
      eventId: 'humid-cell', ageSeconds: 2_400, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.9,
    });
    const residual = cloudLifecycleAt({
      eventId: 'humid-cell', ageSeconds: 5_400, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.9,
    });
    assert.ok(active.updraftFraction > residual.updraftFraction);
    assert.ok(residual.anvilFraction > 0);
    assert.ok(residual.residualIceFraction > 0);
  });

  test('cloud lifecycle: dry upper air removes residual anvil faster than humid upper air', () => {
    const humid = cloudLifecycleAt({
      eventId: 'cell', ageSeconds: 7_200, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.9,
    });
    const dry = cloudLifecycleAt({
      eventId: 'cell', ageSeconds: 7_200, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.2,
    });
    assert.ok(humid.residualIceFraction > dry.residualIceFraction);
  });

  test('cloud lifecycle: cold-pool trigger grows after mature convection begins', () => {
    const early = cloudLifecycleAt({
      eventId: 'cell', ageSeconds: 300, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.7,
    });
    const late = cloudLifecycleAt({
      eventId: 'cell', ageSeconds: 3_300, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.7,
    });
    assert.ok(late.gustFrontTriggerFraction > early.gustFrontTriggerFraction);
  });

  test('cloud lifecycle: event identity changes anvil morphology but not phase', () => {
    const a = cloudLifecycleAt({
      eventId: 'a', ageSeconds: 2_000, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.7,
    });
    const b = cloudLifecycleAt({
      eventId: 'b', ageSeconds: 2_000, convectiveDurationSeconds: 3_600,
      upperRelativeHumidity: 0.7,
    });
    assert.equal(a.phase, b.phase);
    assert.notEqual(a.anvilAxisAngleRad, b.anvilAxisAngleRad);
    assert.notEqual(a.anvilAspectRatio, b.anvilAspectRatio);
  });
}
