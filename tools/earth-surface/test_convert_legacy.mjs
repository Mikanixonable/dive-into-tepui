#!/usr/bin/env node
// v1 wire(4ch float16)からv3 wire(4ch uint8)への地形変換を、小さな実体で検査する。
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertLegacyTerrain } from './convert-legacy-terrain.mjs';
import {
  EARTH_TERRAIN_BYTES, EARTH_TERRAIN_CHANNELS, EARTH_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_HEADER_BYTES, EARTH_TERRAIN_HEIGHT, EARTH_TERRAIN_SCALAR_UINT8,
  EARTH_TERRAIN_WIDTH,
} from './contract.mjs';

const LEGACY_BYTES = EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * EARTH_TERRAIN_CHANNELS * 2;
const LEGACY_PAYLOAD_BYTES = EARTH_TERRAIN_HEADER_BYTES + LEGACY_BYTES;

// v1 ESTN(4ch float16)を組み立てる。テクセルには先頭の1つだけ非自明な値を入れる。
function legacyTerrainPayload({ z = 0, x = 0, y = 0, texels = [[0.5, -0.5, Math.SQRT1_2, 0.8]] } = {}) {
  const payload = Buffer.alloc(LEGACY_PAYLOAD_BYTES);
  payload.write('ESTN', 0, 'ascii');
  payload.writeUInt16LE(1, 4); payload.writeUInt16LE(EARTH_TERRAIN_HEADER_BYTES, 6);
  payload.writeUInt16LE(EARTH_TERRAIN_WIDTH, 8); payload.writeUInt16LE(EARTH_TERRAIN_HEIGHT, 10);
  payload.writeUInt8(z, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(x, 14); payload.writeUInt32LE(y, 18);
  payload.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); payload.writeUInt8(1, 23);
  payload.writeUInt32LE(LEGACY_BYTES, 24); payload.writeUInt32LE(0, 28);
  const body = new Float16Array(LEGACY_BYTES / 2);
  for (const [index, texel] of texels.entries()) body.set(texel, index * EARTH_TERRAIN_CHANNELS);
  Buffer.from(body.buffer).copy(payload, EARTH_TERRAIN_HEADER_BYTES);
  return payload;
}

// v1 ESTB(2枚のz=0 ESTN)を組み立てる。
function legacyBasePayload() {
  const body = Buffer.concat([legacyTerrainPayload({ x: 0 }), legacyTerrainPayload({ x: 1 })]);
  const payload = Buffer.alloc(EARTH_TERRAIN_HEADER_BYTES + body.length);
  payload.write('ESTB', 0, 'ascii');
  payload.writeUInt16LE(1, 4); payload.writeUInt16LE(EARTH_TERRAIN_HEADER_BYTES, 6);
  payload.writeUInt16LE(EARTH_TERRAIN_WIDTH, 8); payload.writeUInt16LE(EARTH_TERRAIN_HEIGHT, 10);
  payload.writeUInt8(0, 12); payload.writeUInt8(0, 13);
  payload.writeUInt32LE(2, 14); payload.writeUInt32LE(1, 18);
  payload.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); payload.writeUInt8(1, 23);
  payload.writeUInt32LE(body.length, 24); payload.writeUInt32LE(0, 28);
  body.copy(payload, EARTH_TERRAIN_HEADER_BYTES);
  return payload;
}

async function run() {
  const input = await mkdtemp(join(tmpdir(), 'earth-legacy-in-'));
  const output = await mkdtemp(join(tmpdir(), 'earth-legacy-out-'));
  try {
    await mkdir(join(input, 'base'), { recursive: true });
    await writeFile(join(input, 'base/earth.bin.gz'), gzipSync(legacyBasePayload(), { mtime: 0 }));
    await mkdir(join(input, 'tiles/4/0'), { recursive: true });
    await writeFile(join(input, 'tiles/4/0/0.bin.gz'), gzipSync(legacyTerrainPayload({ z: 4 }), { mtime: 0 }));
    await mkdir(join(input, 'tiles/5/3'), { recursive: true });
    await writeFile(join(input, 'tiles/5/3/7.bin.gz'), gzipSync(legacyTerrainPayload({ z: 5, x: 3, y: 7 }), { mtime: 0 }));
    await mkdir(join(input, 'tiles/7/140'), { recursive: true });
    await writeFile(join(input, 'tiles/7/140/60.bin.gz'), gzipSync(legacyTerrainPayload({ z: 7, x: 140, y: 60 }), { mtime: 0 }));

    const keys = await convertLegacyTerrain({ inputRoot: input, outputRoot: output });
    // z<minZoom のタイルは現行契約の対象外なので変換されない。
    assert.deepEqual(keys.map((key) => key.id).sort(), ['5/3/7', '7/140/60']);

    const tile = gunzipSync(await readFile(join(output, 'tiles/5/3/7.bin.gz')));
    assert.equal(tile.toString('ascii', 0, 4), 'ESTN');
    assert.equal(tile.readUInt16LE(4), EARTH_TERRAIN_FORMAT_VERSION);
    assert.equal(tile.readUInt8(12), 5);
    assert.equal(tile.readUInt32LE(14), 3);
    assert.equal(tile.readUInt32LE(18), 7);
    assert.equal(tile.readUInt8(22), EARTH_TERRAIN_CHANNELS);
    assert.equal(tile.readUInt8(23), EARTH_TERRAIN_SCALAR_UINT8);
    assert.equal(tile.readUInt32LE(24), EARTH_TERRAIN_BYTES);
    // 先頭テクセル (0.5, -0.5, √1/2, 0.8) が v3 の並びで量子化される。
    const encode = (value) => Math.round((value * 0.5 + 0.5) * 255);
    const head = tile.subarray(EARTH_TERRAIN_HEADER_BYTES, EARTH_TERRAIN_HEADER_BYTES + 4);
    assert.equal(head[0], encode(0.5));
    assert.equal(head[1], encode(-0.5));
    assert.ok(Math.abs(head[2] - encode(Math.SQRT1_2)) <= 1);
    assert.equal(head[3], Math.round(0.8 * 255));

    const base = gunzipSync(await readFile(join(output, 'base/earth.bin.gz')));
    assert.equal(base.toString('ascii', 0, 4), 'ESTB');
    assert.equal(base.readUInt16LE(4), EARTH_TERRAIN_FORMAT_VERSION);
    assert.equal(base.readUInt8(23), EARTH_TERRAIN_SCALAR_UINT8);
    assert.equal(base.readUInt32LE(24), 2 * (EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES));
    assert.equal(base.toString('ascii', EARTH_TERRAIN_HEADER_BYTES, EARTH_TERRAIN_HEADER_BYTES + 4), 'ESTN');
    console.log('earth-surface legacy terrain conversion: ok');
  } finally {
    await rm(input, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}
