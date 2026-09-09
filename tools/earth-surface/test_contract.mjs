#!/usr/bin/env node
// Stage A の配信契約を、小さく固定した決定的な実体で検査する。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync, gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packageEarthSurface } from './package.mjs';
import { checkEarthSurface } from './check.mjs';
import { canonicalSha256, EARTH_TERRAIN_BYTES, EARTH_TERRAIN_PAYLOAD_BYTES } from './contract.mjs';

const execFileAsync = promisify(execFile);

function terrainPayload({ z = 0, x = 0, y = 0 } = {}) {
  const payload = Buffer.alloc(EARTH_TERRAIN_PAYLOAD_BYTES);
  payload.write('ESTN', 0, 'ascii');
  payload.writeUInt16LE(1, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10);
  payload.writeUInt8(z, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(x, 14); payload.writeUInt32LE(y, 18);
  payload.writeUInt8(4, 22); payload.writeUInt8(1, 23);
  payload.writeUInt32LE(EARTH_TERRAIN_BYTES, 24); payload.writeUInt32LE(0, 28);
  return payload;
}

function baseTerrainPayload() {
  const body = Buffer.concat([terrainPayload({ x: 0 }), terrainPayload({ x: 1 })]);
  const payload = Buffer.alloc(32 + body.length);
  payload.write('ESTB', 0, 'ascii');
  payload.writeUInt16LE(1, 4); payload.writeUInt16LE(32, 6);
  payload.writeUInt16LE(260, 8); payload.writeUInt16LE(260, 10);
  payload.writeUInt8(0, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(2, 14); payload.writeUInt32LE(1, 18);
  payload.writeUInt8(4, 22); payload.writeUInt8(1, 23);
  payload.writeUInt32LE(body.length, 24); payload.writeUInt32LE(0, 28);
  body.copy(payload, 32);
  return payload;
}

function climatePng() {
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type, 'ascii');
    const body = Buffer.concat([name, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1024, 0); ihdr.writeUInt32BE(512, 4);
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(6, 9);
  const rows = Buffer.alloc(512 * (1 + 1024 * 4));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function manifest(sourceManifestSha256, datasetId = 'earth-fixture-a') {
  return {
    schemaVersion: 1, datasetId, sourceManifestSha256,
    provenance: { generator: 'fixture/1' },
    climateMap: { width: 1024, height: 512, channels: 4, scalar: 'UInt8' },
    controlRegions: Array.from({ length: 16 }, (_, index) => ({ id: `region-${index}`, west: -180, south: -80, east: 180, north: 80 })),
    coverage: { kind: 'sparse', maxZoom: 7 },
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
  const color = Buffer.from('fixture-color-jpeg-bytes');
  const terrain = terrainPayload();
  const compressedTerrain = gzipSync(terrain, { mtime: 0 });
  const manifestValue = manifest(sourceHash);
  const tile = {
    schemaVersion: 1, datasetId: manifestValue.datasetId,
    entries: [{
      key: '0/0/0', z: 0, x: 0, y: 0,
      color: { url: 'tiles/0/0/0.jpg', sha256: createHash('sha256').update(color).digest('hex'), encodedBytes: color.length, payloadBytes: color.length },
      terrain: { url: 'tiles/0/0/0.bin.gz', sha256: createHash('sha256').update(terrain).digest('hex'), encodedBytes: compressedTerrain.length, payloadBytes: terrain.length },
    }],
  };
  await writeFile(join(root, 'sources.json'), `${JSON.stringify(source)}\n`);
  await writeFile(join(root, 'earth-surface.json'), `${JSON.stringify(manifestValue, null, 2)}\n`);
  await writeFile(join(root, 'tile-index.json'), `${JSON.stringify(tile, null, 2)}\n`);
  await mkdir(join(root, 'base'), { recursive: true });
  await writeFile(join(root, 'base/earth.jpg'), color); await writeFile(join(root, 'base/earth.bin.gz'), gzipSync(baseTerrainPayload(), { mtime: 0 }));
  await mkdir(join(root, 'climate'), { recursive: true });
  for (const path of manifestValue.climateMaps) await writeFile(join(root, path), climatePng());
  await mkdir(join(root, 'tiles/0/0'), { recursive: true });
  await writeFile(join(root, 'tiles/0/0/0.jpg'), color);
  await writeFile(join(root, 'tiles/0/0/0.bin.gz'), compressedTerrain);
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
    await packageEarthSurface({ inputRoot: fixture.root, outputRoot: output, sourceManifestPath: 'sources.json' });
    const packaged = join(output, 'earth', fixture.manifest.datasetId);
    const result = await checkEarthSurface({ inputRoot: packaged });
    assert.deepEqual(result, { datasetId: fixture.manifest.datasetId, tiles: 1, climateMaps: 12 });
    const cli = await execFileAsync('npm', ['run', 'earth-surface:check', '--', '--input', packaged], { cwd: process.cwd() });
    assert.match(cli.stdout, /earth-surface:check: earth-fixture-a/);
    for (const path of [
      'earth-surface.json', 'tile-index.json', 'attribution.json', fixture.manifest.baseColor, fixture.manifest.baseTerrain,
      ...fixture.manifest.climateMaps, 'tiles/0/0/0.jpg', 'tiles/0/0/0.bin.gz',
      'receipt.json',
    ]) await readFile(join(packaged, path));
    assert.deepEqual(await readFile(join(fixture.root, 'earth-surface.json')), before);

    const changedColor = await readFile(join(packaged, 'tiles/0/0/0.jpg'));
    changedColor[0] ^= 1; await writeFile(join(packaged, 'tiles/0/0/0.jpg'), changedColor);
    await expectFailure(() => checkEarthSurface({ inputRoot: packaged }), /color .*hash mismatch/);
    await writeFile(join(packaged, 'tiles/0/0/0.jpg'), fixture.color);

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

    index.entries[0].color.url = 'tiles/../0/0/0.jpg'; await writeFile(indexPath, JSON.stringify(index));
    await expectFailure(() => checkEarthSurface({ inputRoot: fixture.root }), /invalid path/);
    index.entries[0].color.url = 'tiles/0/0/0.jpg'; await writeFile(indexPath, JSON.stringify(index));

    const terrainPath = join(fixture.root, 'tiles/0/0/0.bin.gz');
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

    index.entries.push({ ...index.entries[0], key: '0/0/0', color: index.entries[0].color, terrain: index.entries[0].terrain });
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
