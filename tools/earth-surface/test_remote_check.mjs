#!/usr/bin/env node
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageEarthSurface } from './package.mjs';
import { remoteCheckEarthSurface } from './remote-check.mjs';
import { earthSurfaceServer } from './serve.mjs';
import { createBundle } from './test_contract.mjs';

const fixture = await createBundle();
const output = await mkdtemp(join(tmpdir(), 'earth-surface-remote-'));
let server;
try {
  await packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' });
  server = earthSurfaceServer(output, 0, { allowedOrigins: ['https://game.example.test'] });
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/earth/${fixture.manifest.datasetId}/`;

  const result = await remoteCheckEarthSurface({
    baseUrl, datasetId: fixture.manifest.datasetId, origin: 'https://game.example.test',
  });
  assert.equal(result.climateMaps, 12);
  assert.equal(result.representative, '0/0/0');

  const manifestResponse = await fetch(`${baseUrl}earth-surface.json`, { headers: { Origin: 'https://game.example.test' } });
  assert.equal(manifestResponse.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  assert.equal(manifestResponse.headers.get('access-control-allow-origin'), 'https://game.example.test');
  const headResponse = await fetch(`${baseUrl}tiles/0/0/0.bin.gz`, { method: 'HEAD' });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), '');
  assert.equal(headResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(headResponse.headers.get('content-type'), 'application/gzip');
  assert.equal(headResponse.headers.get('content-encoding'), null);

  const optionsResponse = await fetch(baseUrl, {
    method: 'OPTIONS', headers: { Origin: 'https://game.example.test' },
  });
  assert.equal(optionsResponse.status, 204);
  assert.equal(optionsResponse.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
  assert.equal(optionsResponse.headers.get('access-control-allow-origin'), 'https://game.example.test');
  console.log('earth-surface remote contract fixtures: ok');
} finally {
  server?.close();
  await rm(fixture.root, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
}
