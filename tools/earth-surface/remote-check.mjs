#!/usr/bin/env node
// 外部静的配信先の地表bundleを、認証なしのHTTP契約だけで検査する。
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  validateManifest, validateTileIndex, EarthSurfaceContractError,
} from './contract.mjs';

function fail(message) { throw new EarthSurfaceContractError(message); }

function urlFor(baseUrl, path) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function request(fetchImpl, url, method = 'GET', origin) {
  const response = await fetchImpl(url, {
    method,
    headers: origin === undefined ? undefined : { Origin: origin },
  });
  if (!response.ok) fail(`${method} ${url} returned HTTP ${response.status}`);
  if (origin !== undefined) {
    const allowed = response.headers.get('access-control-allow-origin');
    if (allowed !== '*' && allowed !== origin) fail(`CORS origin is not allowed: ${url}`);
  }
  return response;
}

async function bytes(fetchImpl, baseUrl, path, origin) {
  const response = await request(fetchImpl, urlFor(baseUrl, path), 'GET', origin);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length === 0) fail(`empty remote asset: ${path}`);
  return { response, body };
}

function expectContent(response, path) {
  const contentType = response.headers.get('content-type') ?? '';
  if (path.endsWith('.bin.gz')) {
    if (!contentType.toLowerCase().startsWith('application/gzip')) fail(`raw gzip MIME is invalid: ${path}`);
    if (response.headers.get('content-encoding') !== null) fail(`raw gzip must not use Content-Encoding: ${path}`);
  }
  if (path.endsWith('.jpg') && !contentType.toLowerCase().startsWith('image/jpeg')) fail(`JPEG MIME is invalid: ${path}`);
  if (path.endsWith('.png') && !contentType.toLowerCase().startsWith('image/png')) fail(`PNG MIME is invalid: ${path}`);
}

function verifyHash(body, expected, path) {
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) fail(`remote hash mismatch: ${path}`);
}

function verifyTerrain(body, key, path) {
  let payload;
  try { payload = gunzipSync(body); } catch (error) { throw new EarthSurfaceContractError(`invalid remote gzip: ${path}`, { cause: error }); }
  if (payload.subarray(0, 4).toString('ascii') !== 'ESTN') fail(`remote terrain is not ESTN: ${path}`);
  if (payload.readUInt8(12) !== key.z || payload.readUInt32LE(14) !== key.x || payload.readUInt32LE(18) !== key.y) {
    fail(`remote terrain key mismatch: ${path}`);
  }
}

/** 指定版のmanifest、気候12枚、base、代表タイルを取得して検査する。 */
export async function remoteCheckEarthSurface({
  baseUrl, datasetId, fetchImpl = fetch, representativeKey, origin,
} = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) fail('baseUrl is required');
  const manifestAsset = await bytes(fetchImpl, baseUrl, 'earth-surface.json', origin);
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(manifestAsset.body)));
  if (manifest.datasetId !== datasetId) fail(`datasetId mismatch: ${manifest.datasetId}`);
  expectContent(manifestAsset.response, 'earth-surface.json');
  const indexAsset = await bytes(fetchImpl, baseUrl, manifest.tileIndexUrl, origin);
  const index = validateTileIndex(JSON.parse(new TextDecoder().decode(indexAsset.body)), manifest);
  expectContent(indexAsset.response, manifest.tileIndexUrl);

  const selected = representativeKey === undefined
    ? index.entries[0]
    : index.entries.find((entry) => entry.key === representativeKey);
  if (selected === undefined) fail(`representative tile is missing: ${representativeKey}`);

  const paths = [manifest.baseColor, manifest.baseTerrain, ...manifest.climateMaps];
  const downloaded = [];
  for (const path of paths) {
    const asset = await bytes(fetchImpl, baseUrl, path, origin);
    expectContent(asset.response, path);
    downloaded.push(path);
    if (path.endsWith('.bin.gz')) {
      const payload = gunzipSync(asset.body);
      if (payload.subarray(0, 4).toString('ascii') !== 'ESTB') fail(`remote base terrain is not ESTB: ${path}`);
    }
  }
  for (const asset of [selected.color, selected.terrain]) {
    const value = await bytes(fetchImpl, baseUrl, asset.url, origin);
    expectContent(value.response, asset.url);
    if (asset.url.endsWith('.bin.gz')) {
      const payload = gunzipSync(value.body);
      verifyHash(payload, asset.sha256, asset.url);
      verifyTerrain(value.body, selected, asset.url);
    } else {
      verifyHash(value.body, asset.sha256, asset.url);
    }
    downloaded.push(asset.url);
  }
  return { datasetId, tileCount: index.entries.length, climateMaps: manifest.climateMaps.length, representative: selected.key, downloaded };
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const result = await remoteCheckEarthSurface({
    baseUrl: args.get('--base-url'), datasetId: args.get('--dataset-id'), representativeKey: args.get('--tile'),
    origin: args.get('--origin'),
  });
  console.log(`earth-surface:remote-check: ${result.datasetId} (${result.tileCount} tiles, ${result.climateMaps} climate maps)`);
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  main().catch((error) => { console.error(`earth-surface:remote-check: ${error.message}`); process.exitCode = 1; });
}
