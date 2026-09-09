#!/usr/bin/env node
// 地表マニフェストとタイル索引の配信契約を検査する共有実装。
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export const EARTH_TILE_MAX_Z = 7;
export const EARTH_TERRAIN_HEADER_BYTES = 32;
export const EARTH_TERRAIN_WIDTH = 260;
export const EARTH_TERRAIN_HEIGHT = 260;
export const EARTH_TERRAIN_CHANNELS = 4;
export const EARTH_TERRAIN_SCALAR_FLOAT16 = 1;
export const EARTH_TERRAIN_BYTES = EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * EARTH_TERRAIN_CHANNELS * 2;
export const EARTH_TERRAIN_PAYLOAD_BYTES = EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES;

const DATASET = /^[a-z0-9-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TILE_URL = /^tiles\/(\d+)\/(\d+)\/(\d+)\.(jpg|bin\.gz)$/;

export class EarthSurfaceContractError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'EarthSurfaceContractError';
  }
}

export function assetPath(root, value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/')
    || value.includes('\\') || value.split('/').some((part) => part === '..' || part === '.')) {
    throw new EarthSurfaceContractError(`invalid asset path: ${value}`);
  }
  const base = resolve(root);
  const result = resolve(base, value);
  if (result !== base && !result.startsWith(`${base}${sep}`)) {
    throw new EarthSurfaceContractError(`asset escapes root: ${value}`);
  }
  return result;
}

function fail(message) {
  throw new EarthSurfaceContractError(message);
}

function expectObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function expectString(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function expectSha256(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${name} must be a lowercase SHA-256`);
  return value;
}

function expectPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function expectRange(value, name, min, max) {
  const range = expectObject(value, name);
  if (range.min !== min || range.max !== max) fail(`${name} must be ${min}..${max}`);
  return range;
}

function expectAttribution(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('attribution must be a non-empty string array');
  }
  return value;
}

function expectClimateEncoding(value) {
  const encoding = expectObject(value, 'climateEncoding');
  expectRange(encoding.temperatureK, 'climateEncoding.temperatureK', 180, 330);
  expectRange(encoding.cloudFraction, 'climateEncoding.cloudFraction', 0, 1);
  expectRange(encoding.orthometricElevation, 'climateEncoding.orthometricElevation', -1000, 9000);
  expectRange(encoding.landFraction, 'climateEncoding.landFraction', 0, 1);
  return encoding;
}

export function validateManifest(value) {
  const manifest = expectObject(value, 'earth-surface manifest');
  if (manifest.schemaVersion !== 1) fail('unsupported earth surface manifest schema');
  if (typeof manifest.datasetId !== 'string' || !DATASET.test(manifest.datasetId)) fail('invalid earth surface datasetId');
  expectSha256(manifest.sourceManifestSha256, 'sourceManifestSha256');
  for (const name of ['baseColor', 'baseTerrain', 'tileIndexUrl']) {
    expectString(manifest[name], name);
    if (manifest[name].startsWith('http:') || manifest[name].startsWith('https:')) fail(`${name} must be a relative URL`);
  }
  if (!Array.isArray(manifest.climateMaps) || manifest.climateMaps.length !== 12) fail('exactly 12 climate maps are required');
  manifest.climateMaps.forEach((path, index) => {
    expectString(path, `climateMaps[${index}]`);
    if (path.startsWith('http:') || path.startsWith('https:')) fail(`climateMaps[${index}] must be a relative URL`);
  });
  if (new Set(manifest.climateMaps).size !== manifest.climateMaps.length) fail('climateMaps must not contain duplicate URLs');
  expectClimateEncoding(manifest.climateEncoding);
  expectAttribution(manifest.attribution);
  return manifest;
}

function validateTileKey(z, x, y, label) {
  if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > EARTH_TILE_MAX_Z) fail(`${label} has an invalid z`);
  if (x < 0 || x >= 2 ** (z + 1)) fail(`${label} has an invalid x`);
  if (y < 0 || y >= 2 ** z) fail(`${label} has an invalid y`);
  return { z, x, y };
}

function parseTileUrl(url, key, kind) {
  expectString(url, `${kind}.url`);
  if (url.startsWith('http:') || url.startsWith('https:')) fail(`${kind}.url must be relative`);
  if (url.includes('?') || url.includes('#')) fail(`${kind}.url must not contain a query or fragment`);
  const match = TILE_URL.exec(url);
  if (match === null) fail(`${kind}.url has an invalid path`);
  const urlKey = validateTileKey(Number(match[1]), Number(match[2]), Number(match[3]), `${kind}.url`);
  if (urlKey.z !== key.z || urlKey.x !== key.x || urlKey.y !== key.y) fail(`${kind}.url key mismatch`);
  const extension = kind === 'color' ? 'jpg' : 'bin.gz';
  if (match[4] !== extension) fail(`${kind}.url extension mismatch`);
}

function normalizeFile(value, name) {
  const file = expectObject(value, name);
  expectString(file.url, `${name}.url`);
  expectSha256(file.sha256, `${name}.sha256`);
  expectPositiveInteger(file.encodedBytes, `${name}.encodedBytes`);
  expectPositiveInteger(file.payloadBytes, `${name}.payloadBytes`);
  return file;
}

function entryFile(entry, kind) {
  const nested = entry[kind];
  if (nested !== undefined) return normalizeFile(nested, `entry.${kind}`);
  const prefix = kind === 'color' ? 'color' : 'terrain';
  return normalizeFile({
    url: entry[`${prefix}Url`], sha256: entry[`${prefix}Sha256`],
    encodedBytes: entry[`${prefix}EncodedBytes`], payloadBytes: entry[`${prefix}PayloadBytes`],
  }, `entry.${kind}`);
}

export function validateTileIndex(value, manifest) {
  const index = expectObject(value, 'tile-index');
  if (index.schemaVersion !== 1) fail('unsupported tile-index schema');
  if (index.datasetId !== manifest.datasetId) fail('tile-index datasetId mismatch');
  if (!Array.isArray(index.entries) || index.entries.length === 0) fail('tile-index entries must be non-empty');
  const keys = new Set();
  const entries = index.entries.map((entry, position) => {
    expectObject(entry, `tile-index.entries[${position}]`);
    const z = entry.z;
    const x = entry.x;
    const y = entry.y;
    const key = validateTileKey(z, x, y, `tile-index.entries[${position}]`);
    const expectedId = `${z}/${x}/${y}`;
    if (entry.key !== expectedId) fail(`tile-index.entries[${position}] key mismatch`);
    if (keys.has(expectedId)) fail(`duplicate tile-index key: ${expectedId}`);
    keys.add(expectedId);
    const color = entryFile(entry, 'color');
    const terrain = entryFile(entry, 'terrain');
    parseTileUrl(color.url, key, 'color');
    parseTileUrl(terrain.url, key, 'terrain');
    if (color.payloadBytes !== color.encodedBytes) fail(`color byte lengths must match: ${expectedId}`);
    if (terrain.payloadBytes !== EARTH_TERRAIN_PAYLOAD_BYTES) fail(`terrain payload length mismatch: ${expectedId}`);
    return { ...entry, key: expectedId, z, x, y, color, terrain };
  });
  return { ...index, entries };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function canonicalSha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function requiredFile(root, value, name) {
  const path = assetPath(root, value);
  let info;
  try { info = await stat(path); } catch (error) { throw new EarthSurfaceContractError(`${name} is missing: ${value}`, { cause: error }); }
  if (!info.isFile() || info.size === 0) fail(`${name} is empty or not a file: ${value}`);
  return { path: value, absolutePath: path, bytes: info.size, sha256: await hashFile(path) };
}

function readEstnHeader(payload, key) {
  if (payload.byteLength !== EARTH_TERRAIN_PAYLOAD_BYTES) fail(`ESTN payload length mismatch: ${key}`);
  if (payload.toString('ascii', 0, 4) !== 'ESTN') fail(`ESTN magic mismatch: ${key}`);
  const version = payload.readUInt16LE(4);
  const headerBytes = payload.readUInt16LE(6);
  const width = payload.readUInt16LE(8);
  const height = payload.readUInt16LE(10);
  const z = payload.readUInt8(12);
  const reserved = payload.readUInt8(13);
  const x = payload.readUInt32LE(14);
  const y = payload.readUInt32LE(18);
  const channels = payload.readUInt8(22);
  const scalar = payload.readUInt8(23);
  const dataBytes = payload.readUInt32LE(24);
  const reserved2 = payload.readUInt32LE(28);
  if (version !== 1 || headerBytes !== EARTH_TERRAIN_HEADER_BYTES || width !== EARTH_TERRAIN_WIDTH
    || height !== EARTH_TERRAIN_HEIGHT || reserved !== 0 || channels !== EARTH_TERRAIN_CHANNELS
    || scalar !== EARTH_TERRAIN_SCALAR_FLOAT16 || dataBytes !== EARTH_TERRAIN_BYTES || reserved2 !== 0
    || z !== key.z || x !== key.x || y !== key.y) fail(`ESTN header key or format mismatch: ${key.id}`);
}

async function verifyAsset(root, asset, name) {
  const actual = await requiredFile(root, asset.url, name);
  if (actual.bytes !== asset.encodedBytes) fail(`${name} encoded length mismatch: ${asset.url}`);
  if (actual.sha256 !== asset.sha256) fail(`${name} hash mismatch: ${asset.url}`);
  return actual;
}

async function verifyTerrain(root, asset, key) {
  const actual = await requiredFile(root, asset.url, `terrain ${key.id}`);
  if (actual.bytes !== asset.encodedBytes) fail(`terrain encoded length mismatch: ${asset.url}`);
  const compressed = await readFile(actual.absolutePath);
  let payload;
  try { payload = gunzipSync(compressed); } catch (error) { throw new EarthSurfaceContractError(`terrain gzip is invalid: ${asset.url}`, { cause: error }); }
  if (payload.byteLength !== asset.payloadBytes) fail(`terrain payload length mismatch: ${asset.url}`);
  const digest = createHash('sha256').update(payload).digest('hex');
  if (digest !== asset.sha256) fail(`terrain ESTN hash mismatch: ${asset.url}`);
  readEstnHeader(payload, key);
  return payload;
}

async function verifySourceManifest(root, sourceManifestPath, expectedHash) {
  if (sourceManifestPath === undefined) return;
  const sourcePath = assetPath(root, sourceManifestPath);
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  if (canonicalSha256(source) !== expectedHash) fail('sourceManifestSha256 mismatch');
}

async function defaultSourceManifestPath(root, manifest, sourceManifestPath) {
  if (sourceManifestPath !== undefined) return sourceManifestPath;
  if (typeof manifest.sourceManifest === 'string') return manifest.sourceManifest;
  try { await access(assetPath(root, 'sources.json')); return 'sources.json'; } catch { return undefined; }
}

export async function inspectEarthSurfaceBundle({ inputRoot, manifestName = 'earth-surface.json', sourceManifestPath } = {}) {
  if (typeof inputRoot !== 'string' || inputRoot.length === 0) throw new TypeError('inputRoot is required');
  const root = resolve(inputRoot);
  const manifestPath = assetPath(root, manifestName);
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { throw new EarthSurfaceContractError(`cannot read manifest: ${manifestName}`, { cause: error }); }
  validateManifest(manifest);
  await verifySourceManifest(root, await defaultSourceManifestPath(root, manifest, sourceManifestPath), manifest.sourceManifestSha256);
  const baseColor = await requiredFile(root, manifest.baseColor, 'baseColor');
  const baseTerrain = await requiredFile(root, manifest.baseTerrain, 'baseTerrain');
  let baseTerrainPayload;
  try { baseTerrainPayload = gunzipSync(await readFile(baseTerrain.absolutePath)); } catch (error) { throw new EarthSurfaceContractError('baseTerrain gzip is invalid', { cause: error }); }
  if (baseTerrainPayload.byteLength === 0) fail('baseTerrain payload is empty');
  const climateMaps = await Promise.all(manifest.climateMaps.map((path, index) => requiredFile(root, path, `climateMaps[${index}]`)));
  const tileIndexPath = assetPath(root, manifest.tileIndexUrl);
  let tileIndex;
  try { tileIndex = JSON.parse(await readFile(tileIndexPath, 'utf8')); } catch (error) { throw new EarthSurfaceContractError(`cannot read tile-index: ${manifest.tileIndexUrl}`, { cause: error }); }
  const normalizedIndex = validateTileIndex(tileIndex, manifest);
  const tiles = [];
  for (const entry of normalizedIndex.entries) {
    const key = { id: entry.key, z: entry.z, x: entry.x, y: entry.y };
    await verifyAsset(root, entry.color, `color ${entry.key}`);
    await verifyTerrain(root, entry.terrain, key);
    tiles.push(entry);
  }
  return { root, manifest, manifestPath, baseColor, baseTerrain, climateMaps, tileIndex: normalizedIndex, tileIndexPath, tiles };
}

export function destinationPath(outputRoot, relativePath) {
  return assetPath(resolve(outputRoot), relativePath);
}

export function manifestDirectory(manifestPath) {
  return dirname(resolve(manifestPath));
}
