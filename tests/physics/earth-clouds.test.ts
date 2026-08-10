import * as assert from 'node:assert/strict';
import {
  EARTH_CLOUD_RADIUS,
  HIGH_CLOUD_ALTITUDE,
  LOW_CLOUD_ALTITUDE,
  advectCloudUv,
  cloudPhaseAt,
  cloudShadowDirection,
  cloudShadowOffset,
  directionToCloudUv,
  projectToCloudLayer,
} from '../../src/physics/earth-clouds';
import { norm, v3 } from '../../src/physics/vec3';
import { test } from './harness';

const closeTo = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
};

export function register(): void {
  test('雲位相は累積状態を持たず、同時刻で常に同じ画像入力になる', () => {
    assert.deepEqual(cloudPhaseAt(12_345, 'low'), cloudPhaseAt(12_345, 'low'));
    assert.deepEqual(advectCloudUv({ u: 0.9999, v: 0.37 }, 12_345, 'high'), advectCloudUv({ u: 0.9999, v: 0.37 }, 12_345, 'high'));
    const low = cloudPhaseAt(86_400, 'low');
    const high = cloudPhaseAt(86_400, 'high');
    assert.notEqual(low.longitudeOffset, high.longitudeOffset);
  });

  test('雲の経度移流はシームを越えても [0,1) に収まり、緩やかな変形を持つ', () => {
    const seam = advectCloudUv({ u: 0.999999, v: 0.52 }, 10_000_000, 'low');
    assert.ok(seam.u >= 0 && seam.u < 1);
    assert.ok(seam.v >= 0 && seam.v <= 1);
    const unchanged = advectCloudUv({ u: 0.25, v: 0.5 }, 0, 'low');
    closeTo(unchanged.u, 0.25);
    closeTo(unchanged.v, 0.5);
  });

  test('方向から雲UVを作る写像は極域を有限に扱い、経度シームを連続にする', () => {
    const east = directionToCloudUv(v3(1, 0, 0));
    const west = directionToCloudUv(v3(-1, 0, 0));
    closeTo(east.v, 0.5);
    closeTo(west.v, 0.5);
    assert.ok(east.u >= 0 && east.u < 1 && west.u >= 0 && west.u < 1);
    const north = directionToCloudUv(v3(0, 100, 0));
    closeTo(north.v, 0);
    assert.ok(Number.isFinite(north.u));
  });

  test('雲影投影は太陽方向の球面接線へ投影し、雲高度が高いほど長くなる', () => {
    const surface = v3(1, 0, 0);
    const sun = norm(v3(0.25, 0.15, 1));
    const low = projectToCloudLayer(surface, sun, LOW_CLOUD_ALTITUDE);
    const high = projectToCloudLayer(surface, sun, HIGH_CLOUD_ALTITUDE);
    closeTo(Math.hypot(low.x, low.y, low.z), 1);
    closeTo(Math.hypot(high.x, high.y, high.z), 1);
    assert.ok(cloudShadowOffset(surface, sun, HIGH_CLOUD_ALTITUDE) > cloudShadowOffset(surface, sun, LOW_CLOUD_ALTITUDE));
    const layerDirection = cloudShadowDirection(surface, sun, 'low');
    closeTo(Math.hypot(layerDirection.x, layerDirection.y, layerDirection.z), 1);
    assert.equal(EARTH_CLOUD_RADIUS, 6_371_000);
  });
}
