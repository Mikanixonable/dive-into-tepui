// 地表・気候入力のdatasetId共有と、要求の世代・dispose境界を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { EarthSurfaceContext } from '../../src/render/earth-surface';
import { assertEarthSurfaceDataset, earthSurfaceSourceFromManifest } from '../../src/game/celestial/solar-system/earth-surface-source';

function source() {
  return earthSurfaceSourceFromManifest('https://example.test/earth/', 'https://example.test/earth/earth-surface.json', {
    schemaVersion: 1, datasetId: 'earth-2026-09-09-a', sourceManifestSha256: '0'.repeat(64),
    baseColor: 'earth.jpg', baseTerrain: 'base.bin.gz', tileIndexUrl: 'tile-index.json',
    climateMaps: Array.from({ length: 12 }, (_, index) => `climate-${String(index + 1).padStart(2, '0')}.png`),
    climateEncoding: {
      temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
      orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
    },
    attribution: ['fixture'],
  });
}

export function register(): void {
  test('earth context: 地表と気候は同じdatasetIdのURL契約を共有する', () => {
    const value = source();
    assert.equal(value.climateMapUrls.length, 12);
    assert.equal(value.sourceManifestSha256, '0'.repeat(64));
    assert.deepEqual(value.climateEncoding.temperatureK, { min: 180, max: 330 });
    assert.ok(value.tileIndexUrl.endsWith('/tile-index.json'));
    assert.ok(value.baseColorUrl.endsWith('/earth.jpg'));
    assertEarthSurfaceDataset(value, 'earth-2026-09-09-a');
    assert.throws(() => assertEarthSurfaceDataset(value, 'other'), /mismatch/);
  });

  test('earth context: 要求を世代境界でキャンセルしdispose後に作れない', () => {
    const context = new EarthSurfaceContext(source());
    const lease = context.requestLease();
    const before = context.generation;
    const after = context.invalidateRequests();
    assert.equal(after, before + 1);
    assert.equal(lease.signal.aborted, true);
    context.dispose();
    assert.throws(() => context.requestLease(), /disposed/);
  });
}
