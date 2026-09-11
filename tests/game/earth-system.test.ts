// 地球系の実体へ地表facadeを接続しても、fallbackの表面URLと月の見た目を保つ。
import * as assert from 'node:assert/strict';
import type { WebGPURenderer } from 'three/webgpu';
import { test } from '../harness';
import { StarMotion } from '../../src/physics/celestial-motion';
import { TEST_EPOCH } from '../physics/test-helpers';
import { CelestialSystem } from '../../src/game/celestial/celestial-system';
import { EARTH_TILE_LAYERS } from '../../src/render/earth-surface-tiles';
import {
  createEarthSurfaceRuntime, EARTH_SURFACE_FIXTURE_SOURCE, EARTH_TEXTURE, earthSystem,
} from '../../src/game/celestial/solar-system/earth-system';
import { SUN } from '../../src/game/celestial/solar-system/sun';

const READY_MANIFEST = {
  schemaVersion: 1,
  datasetId: 'earth-test-2026',
  sourceManifestSha256: '0'.repeat(64),
  baseColor: 'base.jpg',
  baseTerrain: 'base.bin.gz',
  tileIndexUrl: 'tile-index.json',
  climateMaps: Array.from({ length: 12 }, (_, index) => `climate-${index + 1}.png`),
  climateEncoding: {
    temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
    orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
    waterOrthometricElevationM: 0,
  },
  attribution: ['test'],
};

const READY_INDEX = {
  schemaVersion: 1,
  datasetId: READY_MANIFEST.datasetId,
  entries: [{
    key: '0/0/0', z: 0, x: 0, y: 0,
    color: { url: '0-0-0.jpg', sha256: '0'.repeat(64), encodedBytes: 1, payloadBytes: 1 },
    terrain: { url: '0-0-0.bin.gz', sha256: '0'.repeat(64), encodedBytes: 1, payloadBytes: 1 },
  }],
};

function fakeRenderer(isWebGPUBackend: boolean): WebGPURenderer {
  return {
    backend: { isWebGPUBackend, device: { limits: { maxTextureArrayLayers: EARTH_TILE_LAYERS } } },
  } as unknown as WebGPURenderer;
}

function readyFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('earth-surface.json')) return new Response(JSON.stringify(READY_MANIFEST));
    if (url.endsWith('tile-index.json')) return new Response(JSON.stringify(READY_INDEX));
    return new Response('missing', { status: 404 });
  };
}

export function register(): void {
  test('earth system: 地球はfallbackテクスチャを保ち、月の表面は変更しない', () => {
    const bodies = earthSystem(new StarMotion(SUN), {}, 0);
    assert.equal(bodies.earth.surfaceTextureUrl, EARTH_TEXTURE.url);
    assert.match(bodies.moon.surfaceTextureUrl ?? '', /8k_moon\.jpg$/);
    assert.equal(EARTH_SURFACE_FIXTURE_SOURCE.climateMapUrls.length, 12);
  });

  test('earth system: manifestなしのfactoryは即時surfaceとbase fallbackを返す', async () => {
    const runtime = createEarthSurfaceRuntime({ manifestUrl: null });
    assert.equal(runtime.surface.status, 'loading');

    const result = await runtime.ready;
    assert.equal(result.state, 'fallback');
    assert.equal(result.bootstrap.state, 'fallback');
    assert.equal(runtime.surface.status, 'fallback');
    assert.equal(runtime.surface.diagnostics.reason, 'earth surface manifest unavailable');
    assert.equal(result.surface.textureUrl, EARTH_TEXTURE.url);
    result.surface.dispose();
  });

  test('earth runtime: 初期化済みWebGPU rendererとmanifestがそろうと詳細coordinatorへ接続する', async () => {
    const runtime = createEarthSurfaceRuntime({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: readyFetch(),
      renderer: fakeRenderer(true),
    });
    assert.equal(runtime.surface.status, 'loading');
    const result = await runtime.ready;
    assert.equal(result.state, 'ready', result.bootstrap.error?.message ?? '');
    assert.equal(result.bootstrap.state, 'ready');
    assert.equal(result.bootstrap.source?.datasetId, READY_MANIFEST.datasetId);
    assert.equal(result.surface.usesDetailedMaterial, true);
    assert.equal(result.surface.diagnostics.status, 'ready');
    assert.equal(result.surface.diagnostics.reason, null);
    assert.equal(result.surface.diagnostics.residentMaxZ, null);
    runtime.surface.dispose();
  });

  test('earth runtime: manifestが利用できてもrendererなしなら理由付きbaseへ留まる', async () => {
    const result = await createEarthSurfaceRuntime({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: readyFetch(),
    }).ready;
    assert.equal(result.state, 'fallback');
    assert.equal(result.surface.diagnostics.status, 'fallback');
    assert.equal(result.surface.diagnostics.reason, 'renderer unavailable');
    assert.equal(result.surface.usesDetailedMaterial, false);
    result.surface.dispose();
  });

  test('earth runtime: WebGPU非対応rendererは即時fallbackを維持する', async () => {
    const result = await createEarthSurfaceRuntime({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: readyFetch(),
      renderer: fakeRenderer(false),
    }).ready;
    assert.equal(result.state, 'fallback');
    assert.equal(result.surface.usesDetailedMaterial, false);
    assert.equal(result.surface.diagnostics.reason, 'WebGPU detail features unavailable');
    assert.equal(result.surface.textureUrl, EARTH_TEXTURE.url);
    result.surface.dispose();
  });

  test('earth runtime: manifest失敗は既存のbaseテクスチャへ留まる', async () => {
    const result = await createEarthSurfaceRuntime({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: async () => new Response('missing', { status: 503 }),
      renderer: fakeRenderer(true),
    }).ready;
    assert.equal(result.state, 'error');
    assert.equal(result.surface.usesDetailedMaterial, false);
    assert.equal(result.surface.diagnostics.reason, 'Earth surface manifest HTTP 503');
    assert.equal(result.surface.textureUrl, EARTH_TEXTURE.url);
    result.surface.dispose();
  });

  test('earth runtime: dispose後の遅着bootstrapはcoordinatorを公開しない', async () => {
    let release!: (response: Response) => void;
    const manifest = new Promise<Response>((resolve) => { release = resolve; });
    const rest = readyFetch();
    let first = true;
    const runtime = createEarthSurfaceRuntime({
      manifestUrl: 'https://example.test/earth/earth-surface.json',
      fetchImpl: async (input, init) => first
        ? (first = false, manifest)
        : rest(input, init),
      renderer: fakeRenderer(true),
    });
    runtime.surface.dispose();
    release(new Response(JSON.stringify(READY_MANIFEST)));
    const result = await runtime.ready;
    assert.equal(result.state, 'ready', result.bootstrap.error?.message ?? '');
    assert.equal(result.surface.status, 'loading');
  });

  test('earth system: PerfCountsは詳細地表を持つ天体だけ列挙する', () => {
    const bodies = earthSystem(new StarMotion(SUN), {}, 0);
    const system = new CelestialSystem([bodies.earth, bodies.moon], bodies.earth, {}, TEST_EPOCH);
    const surfaces = system.perfCounts().surfaces;
    assert.equal(surfaces.length, 1);
    assert.equal(surfaces[0]?.id, 'earth');
    assert.equal(surfaces[0]?.name, '地球');
    assert.equal(surfaces[0]?.diagnostics.status, 'loading');
  });
}
