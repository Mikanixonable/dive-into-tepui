// 地表・気候入力のdatasetId共有と、要求の世代・dispose境界を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { EarthSurfaceContext } from '../../src/render/earth-surface';
import {
  assertEarthSurfaceDataset, earthSurfaceSourceFromManifest,
  type EarthSurfaceAssetManifest,
} from '../../src/render/earth-surface-source';
import { bootstrapEarthSurface, earthSurfaceManifestUrl } from '../../src/render/earth-surface-runtime';
import { earthTileKey } from '../../src/render/earth-surface-tile-key';

function manifest(schemaVersion: 1 | 2 = 2): EarthSurfaceAssetManifest {
  return {
    schemaVersion, datasetId: 'earth-2026-09-09-a', sourceManifestSha256: '0'.repeat(64),
    terrainEncoding: {
      formatVersion: 2, layout: 'octahedral-rg8-roughness-r8-material-class-a8',
      width: 260, height: 260, channels: 4, scalar: 'UInt8',
      materialClasses: { water: 0, land: 1, ice: 2, unknown: 255 },
    },
    baseColor: 'earth.jpg', baseTerrain: 'base.bin.gz', tileIndexUrl: 'tile-index.json',
    climateMaps: Array.from({ length: 12 }, (_, index) => `climate-${String(index + 1).padStart(2, '0')}.png`),
    climateEncoding: {
      temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
      orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
      waterOrthometricElevationM: 0,
    },
    coverage: schemaVersion === 1
      ? { kind: 'complete' as const, maxZoom: 7 as const, expectedTiles: 43_690 }
      : { kind: 'sparse' as const, minZoom: 4 as const, maxZoom: 7 as const, expectedTiles: null },
    attribution: ['fixture'],
  };
}

function source() {
  return earthSurfaceSourceFromManifest('https://example.test/earth/', 'https://example.test/earth/earth-surface.json', manifest());
}

export function register(): void {
  test('earth context: 地表と気候は同じdatasetIdのURL契約を共有する', () => {
    const value = source();
    assert.equal(value.climateMapUrls.length, 12);
    assert.equal(value.sourceManifestSha256, '0'.repeat(64));
    assert.equal(value.legacyBundle, undefined);
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

  test('earth runtime: Pages subpathをmanifestへ解決し、未設定時はfallback', async () => {
    assert.equal(
      earthSurfaceManifestUrl('', 'https://example.test/tepui/'),
      'https://example.test/tepui/earth-surface/earth-surface.json',
    );
    const fallback = source();
    const result = await bootstrapEarthSurface({ manifestUrl: null, fallback });
    assert.equal(result.state, 'fallback');
    assert.equal(result.source, fallback);
    assert.equal(result.tileSource, null);
  });

  test('earth runtime: manifest取得・検証失敗はerrorとしてbaseを返す', async () => {
    const fallback = source();
    const result = await bootstrapEarthSurface({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fallback,
      fetchImpl: async () => new Response('missing', { status: 404 }),
    });
    assert.equal(result.state, 'error');
    assert.equal(result.source, fallback);
    assert.match(result.error?.message ?? '', /HTTP 404/);
  });

  test('earth runtime: 旧manifestではz0..z3を捨ててz4+だけを使う', async () => {
    const legacy = manifest(1);
    const low = {
      key: '0/0/0', z: 0, x: 0, y: 0,
      color: { url: 'tiles/0/0/0.jpg', sha256: '0'.repeat(64), encodedBytes: 1, payloadBytes: 1 },
      terrain: { url: 'tiles/0/0/0.bin.gz', sha256: '1'.repeat(64), encodedBytes: 1, payloadBytes: 270432 },
    };
    const detail = {
      key: '4/0/0', z: 4, x: 0, y: 0,
      color: { url: 'tiles/4/0/0.jpg', sha256: '2'.repeat(64), encodedBytes: 1, payloadBytes: 1 },
      terrain: { url: 'tiles/4/0/0.bin.gz', sha256: '3'.repeat(64), encodedBytes: 1, payloadBytes: 270432 },
    };
    const result = await bootstrapEarthSurface({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: async (input) => String(input).endsWith('earth-surface.json')
        ? new Response(JSON.stringify(legacy))
        : new Response(JSON.stringify({ schemaVersion: 2, datasetId: legacy.datasetId, entries: [low, detail] })),
    });
    assert.equal(result.state, 'ready');
    assert.equal(result.source?.legacyBundle, true);
    assert.equal(result.tileSource?.descriptorFor(earthTileKey(3, 0, 0)), null);
    assert.ok(result.tileSource?.descriptorFor(earthTileKey(4, 0, 0)));
  });
}
