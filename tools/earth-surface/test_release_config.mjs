#!/usr/bin/env node
import assert from 'node:assert/strict';
import { validateEarthSurfaceReleaseConfig, releaseConfigFromEnvironment } from './release-config.mjs';

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

console.log('earth-surface:release-check tests passed');
