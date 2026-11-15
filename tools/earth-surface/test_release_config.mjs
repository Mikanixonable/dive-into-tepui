#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  checkEarthSurfaceRelease,
  validateEarthSurfaceReleaseConfig,
  releaseConfigFromEnvironment,
} from './release-config.mjs';
import { gzipSync } from 'node:zlib';
import {
  baseTerrainPayload, fixtureManifest, jpegFixture, terrainPayload,
} from './fixture-builders.mjs';

const valid = { baseUrl: 'https://cdn.example.test/earth/v1', datasetId: 'etopo-gshhg-2026' };

assert.equal(validateEarthSurfaceReleaseConfig(valid).baseUrl, 'https://cdn.example.test/earth/v1');
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, baseUrl: '' }), /required/);
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, baseUrl: 'http://cdn.example.test' }), /HTTPS/);
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, baseUrl: 'https://localhost/earth' }), /localhost/);
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, baseUrl: 'https://127.0.0.1/earth' }), /localhost/);
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, baseUrl: 'cdn.example.test/earth' }), /absolute URL/);
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, datasetId: 'ETOPO_GSHHG' }), /datasetId/);
assert.throws(() => validateEarthSurfaceReleaseConfig({ ...valid, allowedOrigins: ['https://other.example.test'] }), /not approved/);
assert.equal(validateEarthSurfaceReleaseConfig({ ...valid, allowedOrigins: ['https://cdn.example.test'] }).origin, 'https://cdn.example.test');

assert.equal(releaseConfigFromEnvironment([], {
  EARTH_SURFACE_BASE_URL: 'https://env.example.test/earth',
  EARTH_SURFACE_DATASET_ID: 'gebco-2026',
}).datasetId, 'gebco-2026');
assert.equal(releaseConfigFromEnvironment(['--base-url', 'https://cli.example.test', '--dataset-id', 'fixture-1']).origin, 'https://cli.example.test');

const manifest = fixtureManifest({
  sourceManifestSha256: '0'.repeat(64),
  datasetId: 'earth-2026-09-09-a',
  generator: 'release-fixture/1',
  attribution: ['release fixture'],
});

const legacyManifest = {
  ...manifest,
  schemaVersion: 1,
  terrainEncoding: {
    formatVersion: 2,
    layout: 'octahedral-rg8-roughness-r8-material-class-a8',
    width: 260,
    height: 260,
    channels: 4,
    scalar: 'UInt8',
    materialClasses: { water: 0, land: 1, ice: 2, unknown: 255 },
  },
  baseColor: 'earth.jpg',
  tileIndexUrl: 'tile-index.json',
  coverage: { kind: 'complete', maxZoom: 7, expectedTiles: 43_690 },
};

const releaseRequests = [];
const releaseManifestUrl = 'https://cdn.example.test/earth/earth-surface.json';

// 配信側のバイト列を差し替えられる fetch。地形は契約どおりの gzip を既定にする。
function releaseFetch({
  baseTerrain = gzipSync(baseTerrainPayload(), { mtime: 0 }),
  tile = gzipSync(terrainPayload({ z: 5 }), { mtime: 0 }),
  requests,
} = {}) {
  return async (input) => {
    const url = String(input);
    requests?.push(url);
    if (url === releaseManifestUrl) return new Response(JSON.stringify(manifest), { status: 200 });
    if (url.endsWith('/base/earth.jpg')) return new Response(jpegFixture({ width: 8192, height: 4096 }), { status: 200 });
    if (url.endsWith('/base/earth.bin.gz')) return new Response(baseTerrain, { status: 200 });
    if (url.endsWith('/tiles/5/0/0.bin.gz')) return new Response(tile, { status: 200 });
    return new Response('ok', { status: 200 });
  };
}

const releaseResult = await checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, releaseFetch({ requests: releaseRequests }));
assert.equal(releaseResult.manifestSchemaVersion, 3);
assert.equal(releaseRequests.length, 6);

// 配信中の base 地形が、法線を B へ・roughness を A へ書いた旧配置(R2 の障害と同じ形)なら、
// HTTP 200 でも release 検査で弾く。
const swappedTile = (x) => {
  const tileBytes = terrainPayload({ x });
  for (let texel = 32; texel < tileBytes.length; texel += 4) { tileBytes[texel + 2] = 204; tileBytes[texel + 3] = 255; }
  return tileBytes;
};
const swappedBase = Buffer.concat([baseTerrainPayload().subarray(0, 32), swappedTile(0), swappedTile(1)]);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, releaseFetch({ baseTerrain: gzipSync(swappedBase, { mtime: 0 }) })),
/baseTerrain bytes violate the terrain contract/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, releaseFetch({ tile: gzipSync(swappedTile(0), { mtime: 0 }) })),
/terrain tile 5\/0\/0 bytes violate the terrain contract/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, releaseFetch({ baseTerrain: Buffer.from('not-gzip') })),
/baseTerrain bytes violate the terrain contract/);
assert.throws(() => validateEarthSurfaceReleaseConfig({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: 'https://other.example.test/earth-surface.json',
  datasetId: legacyManifest.datasetId,
  allowedOrigins: ['https://cdn.example.test'],
}), /not approved/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: 'other-dataset',
}, async (input) => String(input) === releaseManifestUrl
  ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('ok', { status: 200 })), /datasetId mismatch/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, async (input) => String(input) === releaseManifestUrl
  ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('missing', { status: 404 })), /HTTP 404/);

await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: legacyManifest.datasetId,
}, async (input) => String(input) === releaseManifestUrl
  ? new Response(JSON.stringify(legacyManifest), { status: 200 }) : new Response('ok', { status: 200 }),
), /manifest validation failed: unsupported earth surface manifest schema/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, async (input) => String(input) === releaseManifestUrl
  ? new Response(JSON.stringify(manifest), { status: 200 })
  : String(input).endsWith('/base/earth.jpg')
    ? new Response(jpegFixture({ width: 512, height: 256 }), { status: 200 })
    : new Response('ok', { status: 200 }),
), /8192x4096 RGB JPEG/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, async (input) => String(input) === releaseManifestUrl
  ? new Response(JSON.stringify({ ...manifest, colorCalibration: null }), { status: 200 })
  : new Response('ok', { status: 200 }),
), /manifest validation failed: colorCalibration must be an object/);

console.log('earth-surface:release-check tests passed');
