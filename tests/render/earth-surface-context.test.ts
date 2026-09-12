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

function manifest(): EarthSurfaceAssetManifest {
  return {
    schemaVersion: 3, datasetId: 'earth-2026-09-09-a', sourceManifestSha256: '0'.repeat(64),
    terrainEncoding: {
      formatVersion: 3, layout: 'normal-xyz-rgb8-roughness-a8',
      width: 260, height: 260, channels: 4, scalar: 'UInt8',
    },
    baseColor: 'earth.jpg', baseTerrain: 'base.bin.gz',
    tileTemplates: { color: 'tiles/{z}/{x}/{y}.jpg', terrain: 'tiles/{z}/{x}/{y}.bin.gz' },
    climateMaps: Array.from({ length: 12 }, (_, index) => `climate-${String(index + 1).padStart(2, '0')}.png`),
    climateEncoding: {
      temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
      orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
      waterOrthometricElevationM: 0,
    },
    coverage: { kind: 'complete', minZoom: 5, maxZoom: 7, expectedTiles: 43_008 },
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
    assert.deepEqual(value.climateEncoding.temperatureK, { min: 180, max: 330 });
    assert.ok(value.colorTileTemplate.endsWith('/tiles/{z}/{x}/{y}.jpg'));
    assert.ok(value.terrainTileTemplate.endsWith('/tiles/{z}/{x}/{y}.bin.gz'));
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

  test('earth runtime: schema3のmanifestから決定URLを作り、detailはz5から始める', async () => {
    const current = manifest();
    const result = await bootstrapEarthSurface({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: async (input) => String(input).endsWith('earth-surface.json')
        ? new Response(JSON.stringify(current))
        : new Response('unexpected request', { status: 500 }),
    });
    assert.equal(result.state, 'ready');
    assert.equal(result.tileSource?.descriptorFor(earthTileKey(4, 0, 0)), null);
    assert.deepEqual(result.tileSource?.urlFor(earthTileKey(5, 3, 7)), {
      color: 'https://example.test/earth/tiles/5/3/7.jpg',
      terrain: 'https://example.test/earth/tiles/5/3/7.bin.gz',
    });
  });

  test('earth runtime: schema1/2のmanifestは移行せず拒否する', async () => {
    const legacy = { ...manifest(), schemaVersion: 2 } as unknown as EarthSurfaceAssetManifest;
    const result = await bootstrapEarthSurface({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: async () => new Response(JSON.stringify(legacy)),
    });
    assert.equal(result.state, 'error');
    assert.match(result.error?.message ?? '', /Unsupported Earth surface manifest schema/);
  });
}
