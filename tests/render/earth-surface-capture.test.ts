import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  EARTH_SURFACE_CAPTURE_CASES,
  EARTH_SURFACE_CAPTURE_FRAMES,
  EARTH_SURFACE_CAPTURE_VIEWPORT,
} from '../../src/render/earth-surface-metrics';
import { createEarthSurfaceCaptureApi } from '../../tools/render-lab/earth-surface-capture';

export function register(): void {
  test('earth capture API: 固定条件でデータ未投入を明示する', () => {
    const result = createEarthSurfaceCaptureApi()({
      cases: EARTH_SURFACE_CAPTURE_CASES,
      viewport: EARTH_SURFACE_CAPTURE_VIEWPORT,
      frames: EARTH_SURFACE_CAPTURE_FRAMES,
    });
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.cases.length, EARTH_SURFACE_CAPTURE_CASES.length);
    assert.ok(result.cases.every((entry) => entry.status === 'unavailable'));
    assert.ok(result.cases.every((entry) => entry.reason === 'earth surface dataset is not available'));
  });

  test('earth capture API: 未知ケースと条件違いを拒否する', () => {
    const capture = createEarthSurfaceCaptureApi();
    const valid = {
      cases: EARTH_SURFACE_CAPTURE_CASES,
      viewport: EARTH_SURFACE_CAPTURE_VIEWPORT,
      frames: EARTH_SURFACE_CAPTURE_FRAMES,
    };
    assert.throws(() => capture({ ...valid, cases: ['unknown'] }), /fixed T5 case list/);
    assert.throws(() => capture({ ...valid, viewport: { width: 960, height: 540 } }), /1920x1080/);
    assert.throws(() => capture({ ...valid, frames: 30 }), /300/);
  });
}
