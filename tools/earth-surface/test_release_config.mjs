#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  checkEarthSurfaceRelease,
  validateEarthSurfaceReleaseConfig,
  releaseConfigFromEnvironment,
} from './release-config.mjs';

function jpegFixture(width, height, components = 3) {
  const segment = (marker, body) => Buffer.concat([
    Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body,
  ]);
  const sof = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, components,
    ...Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat()]);
  const sos = Buffer.from([components,
    ...Array.from({ length: components }, (_, index) => [index + 1, 0]).flat(), 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), segment(0xc0, sof), segment(0xda, sos), Buffer.from([0, 0xff, 0xd9]),
  ]);
}

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

const manifest = {
  schemaVersion: 3,
  datasetId: 'earth-2026-09-09-a',
  sourceManifestSha256: '0'.repeat(64),
  colorCalibration: {
    inputEncoding: 'sRGB8', aggregation: 'linear_rgb_area_mean', outputEncoding: 'sRGB8',
    diffuseAlbedoScale: 1, meanLinearRgb: [0.1, 0.1, 0.1], meanRec709Albedo: 0.1,
    bondAlbedo: 0.294, averageHue: [1, 1, 1],
  },
  sourceManifest: 'sources.json',
  provenance: { generator: 'release-fixture/1' },
  terrainEncoding: {
    formatVersion: 3,
    layout: 'normal-xyz-rgb8-roughness-a8',
    width: 260,
    height: 260,
    channels: 4,
    scalar: 'UInt8',
    normalFrame: 'body_fixed',
  },
  climateMap: { width: 1024, height: 512, channels: 4, scalar: 'UInt8' },
  controlRegions: Array.from({ length: 16 }, (_, index) => ({ id: `region-${index}` })),
  coverage: { kind: 'sparse', minZoom: 5, maxZoom: 7, expectedTiles: null },
  baseColor: 'base/earth.jpg',
  baseTerrain: 'base/earth.bin.gz',
  tileTemplates: { color: 'tiles/{z}/{x}/{y}.jpg', terrain: 'tiles/{z}/{x}/{y}.bin.gz' },
  climateMaps: Array.from({ length: 12 }, (_, index) => `climate-${index + 1}.png`),
  climateEncoding: {
    temperatureK: { min: 180, max: 330 },
    cloudFraction: { min: 0, max: 1 },
    orthometricElevation: { min: -1000, max: 9000 },
    landFraction: { min: 0, max: 1 },
    waterOrthometricElevationM: 0,
  },
  attribution: ['release fixture'],
};

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
const releaseResult = await checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, async (input) => {
  const url = String(input);
  releaseRequests.push(url);
  return url === releaseManifestUrl
    ? new Response(JSON.stringify(manifest), { status: 200 })
    : url.endsWith('/base/earth.jpg')
      ? new Response(jpegFixture(8192, 4096), { status: 200 })
    : new Response('ok', { status: 200 });
});
assert.equal(releaseResult.manifestSchemaVersion, 3);
assert.equal(releaseRequests.length, 6);
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
), /requires manifest schema 3/);
await assert.rejects(checkEarthSurfaceRelease({
  baseUrl: 'https://cdn.example.test/earth/',
  manifestUrl: releaseManifestUrl,
  datasetId: manifest.datasetId,
}, async (input) => String(input) === releaseManifestUrl
  ? new Response(JSON.stringify(manifest), { status: 200 })
  : String(input).endsWith('/base/earth.jpg')
    ? new Response(jpegFixture(512, 256), { status: 200 })
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
