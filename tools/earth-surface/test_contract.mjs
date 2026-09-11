#!/usr/bin/env node
// Stage A の配信契約を、小さく固定した決定的な実体で検査する。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packageEarthSurface } from './package.mjs';
import { checkEarthSurface } from './check.mjs';
import {
  canonicalSha256,
  EARTH_BASE_COLOR_COMPONENTS,
  EARTH_BASE_COLOR_HEIGHT,
  EARTH_BASE_COLOR_WIDTH,
  EARTH_LEGACY_BASE_COLOR_HEIGHT,
  EARTH_LEGACY_BASE_COLOR_WIDTH,
  EARTH_TERRAIN_BYTES,
  EARTH_TERRAIN_CHANNELS,
  EARTH_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_LAYOUT,
  EARTH_TERRAIN_PAYLOAD_BYTES,
  EARTH_TERRAIN_SCALAR_UINT8,
  readBaseColorJpeg,
  validateManifest,
  validateTileIndex,
} from './contract.mjs';
import { fixtureClimatePng } from './fixture-climate.mjs';

const execFileAsync = promisify(execFile);

function terrainPayload({ z = 0, x = 0, y = 0 } = {}) {
  const payload = Buffer.alloc(EARTH_TERRAIN_PAYLOAD_BYTES);
  payload.write('ESTN', 0, 'ascii');
  payload.writeUInt16LE(EARTH_TERRAIN_FORMAT_VERSION, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10);
  payload.writeUInt8(z, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(x, 14); payload.writeUInt32LE(y, 18);
  payload.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); payload.writeUInt8(EARTH_TERRAIN_SCALAR_UINT8, 23);
  payload.writeUInt32LE(EARTH_TERRAIN_BYTES, 24); payload.writeUInt32LE(0, 28);
  return payload;
}

function baseTerrainPayload() {
  const body = Buffer.concat([terrainPayload({ x: 0 }), terrainPayload({ x: 1 })]);
  const payload = Buffer.alloc(32 + body.length);
  payload.write('ESTB', 0, 'ascii');
  payload.writeUInt16LE(EARTH_TERRAIN_FORMAT_VERSION, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10);
  payload.writeUInt8(0, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(2, 14); payload.writeUInt32LE(1, 18);
  payload.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); payload.writeUInt8(EARTH_TERRAIN_SCALAR_UINT8, 23);
  payload.writeUInt32LE(body.length, 24); payload.writeUInt32LE(0, 28);
  body.copy(payload, 32);
  return payload;
}

function jpegFixture({ width = EARTH_BASE_COLOR_WIDTH, height = EARTH_BASE_COLOR_HEIGHT,
  components = EARTH_BASE_COLOR_COMPONENTS } = {}) {
  const segment = (marker, payload) => Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload,
  ]);
  const sof = Buffer.alloc(6 + components * 3);
  sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = components;
  for (let index = 0; index < components; index += 1) {
    const offset = 6 + index * 3;
    sof[offset] = index + 1; sof[offset + 1] = 0x11; sof[offset + 2] = 0;
  }
  const sos = Buffer.alloc(4 + components * 2);
  sos[0] = components;
  for (let index = 0; index < components; index += 1) {
    const offset = 1 + index * 2;
    sos[offset] = index + 1; sos[offset + 1] = 0;
  }
  sos[1 + components * 2] = 0; sos[2 + components * 2] = 63; sos[3 + components * 2] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.alloc(14)),
    segment(0xc0, sof),
    segment(0xda, sos),
    Buffer.from([0x00, 0xff, 0xd9]),
  ]);
}

function manifest(sourceManifestSha256, datasetId = 'earth-fixture-a') {
  return {
    schemaVersion: 2, datasetId, sourceManifestSha256,
    provenance: { generator: 'fixture/1' },
    terrainEncoding: { formatVersion: EARTH_TERRAIN_FORMAT_VERSION, layout: EARTH_TERRAIN_LAYOUT,
      width: 260, height: 260, channels: EARTH_TERRAIN_CHANNELS, scalar: 'UInt8',
      materialClasses: { water: 0, land: 1, ice: 2, unknown: 255 } },
    climateMap: { width: 1024, height: 512, channels: 4, scalar: 'UInt8' },
    controlRegions: Array.from({ length: 16 }, (_, index) => ({ id: `region-${index}`, west: -180, south: -80, east: 180, north: 80 })),
    coverage: { kind: 'sparse', minZoom: 4, maxZoom: 7, expectedTiles: null },
    baseColor: 'base/earth.jpg', baseTerrain: 'base/earth.bin.gz', tileIndexUrl: 'tile-index.json',
    climateMaps: Array.from({ length: 12 }, (_, index) => `climate/${String(index + 1).padStart(2, '0')}.png`),
    climateEncoding: {
      temperatureK: { min: 180, max: 330 }, cloudFraction: { min: 0, max: 1 },
      orthometricElevation: { min: -1000, max: 9000 }, landFraction: { min: 0, max: 1 },
      waterOrthometricElevationM: 0,
    },
    attribution: ['deterministic Stage A fixture'],
  };
}

async function createBundle() {
  const root = await mkdtemp(join(tmpdir(), 'earth-surface-contract-'));
  const source = { schemaVersion: 1, datasetId: 'earth-fixture-a', sources: [{ id: 'fixture', inputSha256: [] }] };
  const sourceHash = canonicalSha256(source);
  const color = jpegFixture();
  const terrain = terrainPayload({ z: 4 });
  const compressedTerrain = gzipSync(terrain, { mtime: 0 });
  const manifestValue = manifest(sourceHash);
  const tile = {
    schemaVersion: 2, datasetId: manifestValue.datasetId,
    entries: [{
      key: '4/0/0', z: 4, x: 0, y: 0,
      color: { url: 'tiles/4/0/0.jpg', sha256: createHash('sha256').update(color).digest('hex'), encodedBytes: color.length, payloadBytes: color.length },
      terrain: { url: 'tiles/4/0/0.bin.gz', sha256: createHash('sha256').update(terrain).digest('hex'), encodedBytes: compressedTerrain.length, payloadBytes: terrain.length },
    }],
  };
  await writeFile(join(root, 'sources.json'), `${JSON.stringify(source)}\n`);
  await writeFile(join(root, 'earth-surface.json'), `${JSON.stringify(manifestValue, null, 2)}\n`);
  await writeFile(join(root, 'tile-index.json'), `${JSON.stringify(tile, null, 2)}\n`);
  await mkdir(join(root, 'base'), { recursive: true });
  await writeFile(join(root, 'base/earth.jpg'), color); await writeFile(join(root, 'base/earth.bin.gz'), gzipSync(baseTerrainPayload(), { mtime: 0 }));
  await mkdir(join(root, 'climate'), { recursive: true });
  for (const [index, path] of manifestValue.climateMaps.entries()) {
    await writeFile(join(root, path), fixtureClimatePng(index));
  }
  await mkdir(join(root, 'tiles/4/0'), { recursive: true });
  await writeFile(join(root, 'tiles/4/0/0.jpg'), color);
  await writeFile(join(root, 'tiles/4/0/0.bin.gz'), compressedTerrain);
  return { root, source, manifest: manifestValue, tile, color, terrain };
}

async function expectFailure(action, pattern) {
  await assert.rejects(action, (error) => error instanceof Error && pattern.test(error.message));
}

async function run() {
  const fixture = await createBundle();
  const output = await mkdtemp(join(tmpdir(), 'earth-surface-distribution-'));
  const before = await readFile(join(fixture.root, 'earth-surface.json'));
  try {
    const legacyManifest = {
      ...fixture.manifest,
      schemaVersion: 1,
      coverage: { kind: 'sparse', maxZoom: 7, expectedTiles: null },
    };
    assert.doesNotThrow(() => validateManifest(legacyManifest));
    assert.doesNotThrow(() => readBaseColorJpeg(jpegFixture({
      width: EARTH_LEGACY_BASE_COLOR_WIDTH, height: EARTH_LEGACY_BASE_COLOR_HEIGHT,
    }), {
      width: EARTH_LEGACY_BASE_COLOR_WIDTH, height: EARTH_LEGACY_BASE_COLOR_HEIGHT,
      components: EARTH_BASE_COLOR_COMPONENTS,
    }));
    const legacyLowEntry = {
      ...fixture.tile.entries[0], key: '0/0/0', z: 0, x: 0, y: 0,
      color: { ...fixture.tile.entries[0].color, url: 'tiles/0/0/0.jpg' },
      terrain: { ...fixture.tile.entries[0].terrain, url: 'tiles/0/0/0.bin.gz' },
    };
    assert.equal(validateTileIndex({ ...fixture.tile, entries: [legacyLowEntry, fixture.tile.entries[0]] }, legacyManifest).entries.length, 2);
    assert.throws(() => validateTileIndex({ ...fixture.tile, entries: [legacyLowEntry, fixture.tile.entries[0]] }, fixture.manifest), /invalid z/);

    await packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' });
    const packaged = join(output, 'earth', fixture.manifest.datasetId);
    const result = await checkEarthSurface({ inputRoot: packaged });
    assert.deepEqual(result, { datasetId: fixture.manifest.datasetId, tiles: 1, climateMaps: 12 });
    const cli = await execFileAsync('npm', ['run', 'earth-surface:check', '--', '--input', packaged], { cwd: process.cwd() });
    assert.match(cli.stdout, /earth-surface:check: earth-fixture-a/);
    for (const path of [
      'earth-surface.json', 'tile-index.json', 'attribution.json', fixture.manifest.baseColor, fixture.manifest.baseTerrain,
      ...fixture.manifest.climateMaps, 'tiles/4/0/0.jpg', 'tiles/4/0/0.bin.gz',
      'receipt.json',
    ]) await readFile(join(packaged, path));
    assert.deepEqual(await readFile(join(fixture.root, 'earth-surface.json')), before);

    const baseColorPath = join(packaged, fixture.manifest.baseColor);
    for (const [replacement, pattern] of [
      [jpegFixture({ width: 260, height: 260 }), /baseColor JPEG must be 8192x4096 with 3 components/],
      [jpegFixture({ components: 1 }), /baseColor JPEG must be 8192x4096 with 3 components/],
      [Buffer.from('not-a-jpeg'), /baseColor JPEG must start with SOI/],
      [jpegFixture().subarray(0, -2), /baseColor JPEG scan is truncated/],
      [(() => { const malformed = jpegFixture(); malformed[4] = 0; malformed[5] = 1; return malformed; })(), /baseColor JPEG marker length is invalid/],
    ]) {
      await writeFile(baseColorPath, replacement);
      await expectFailure(() => checkEarthSurface({ inputRoot: packaged }), pattern);
    }
    await writeFile(baseColorPath, fixture.color);

    const changedColor = await readFile(join(packaged, 'tiles/4/0/0.jpg'));
    changedColor[0] ^= 1; await writeFile(join(packaged, 'tiles/4/0/0.jpg'), changedColor);
    await expectFailure(() => checkEarthSurface({ inputRoot: packaged }), /color .*hash mismatch/);
    await writeFile(join(packaged, 'tiles/4/0/0.jpg'), fixture.color);

    const sourcePath = join(fixture.root, 'sources.json');
    const sourceChanged = { ...fixture.source, datasetId: 'earth-other' };
    await writeFile(sourcePath, JSON.stringify(sourceChanged));
    await expectFailure(() => packageEarthSurface({ inputRoot: fixture.root, outputRoot: output }), /sourceManifestSha256 mismatch/);
    await writeFile(sourcePath, `${JSON.stringify(fixture.source)}\n`);

    const indexPath = join(fixture.root, 'tile-index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.datasetId = 'earth-other'; await writeFile(indexPath, JSON.stringify(index));
    await expectFailure(() => packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' }), /datasetId mismatch/);
    index.datasetId = fixture.manifest.datasetId; await writeFile(indexPath, JSON.stringify(index));

    index.entries[0].color.url = 'tiles/../4/0/0.jpg'; await writeFile(indexPath, JSON.stringify(index));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /invalid path/);
    index.entries[0].color.url = 'tiles/4/0/0.jpg'; await writeFile(indexPath, JSON.stringify(index));

    const terrainPath = join(fixture.root, 'tiles/4/0/0.bin.gz');
    const mismatch = terrainPayload({ x: 1 });
    const mismatchCompressed = gzipSync(mismatch, { mtime: 0 });
    index.entries[0].terrain.encodedBytes = mismatchCompressed.length;
    index.entries[0].terrain.sha256 = createHash('sha256').update(mismatch).digest('hex');
    await writeFile(indexPath, JSON.stringify(index));
    await writeFile(terrainPath, mismatchCompressed);
    await expectFailure(() => packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' }), /ESTN header key or format mismatch/);
    index.entries[0].terrain.encodedBytes = gzipSync(fixture.terrain, { mtime: 0 }).length;
    index.entries[0].terrain.sha256 = createHash('sha256').update(fixture.terrain).digest('hex');
    await writeFile(terrainPath, gzipSync(fixture.terrain, { mtime: 0 }));

    const legacy = Buffer.from(fixture.terrain);
    legacy.writeUInt16LE(1, 4);
    const legacyCompressed = gzipSync(legacy, { mtime: 0 });
    index.entries[0].terrain.encodedBytes = legacyCompressed.length;
    index.entries[0].terrain.sha256 = createHash('sha256').update(legacy).digest('hex');
    await writeFile(indexPath, JSON.stringify(index));
    await writeFile(terrainPath, legacyCompressed);
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /ESTN header key or format mismatch/);
    index.entries[0].terrain.encodedBytes = gzipSync(fixture.terrain, { mtime: 0 }).length;
    index.entries[0].terrain.sha256 = createHash('sha256').update(fixture.terrain).digest('hex');
    await writeFile(indexPath, JSON.stringify(index));
    await writeFile(terrainPath, gzipSync(fixture.terrain, { mtime: 0 }));

    index.entries.push({ ...index.entries[0], key: '4/0/0', color: index.entries[0].color, terrain: index.entries[0].terrain });
    await writeFile(indexPath, JSON.stringify(index));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root, sourceManifestPath: 'sources.json' }), /duplicate tile-index key/);
    console.log('earth-surface contract fixtures: ok');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}

export { createBundle };

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
