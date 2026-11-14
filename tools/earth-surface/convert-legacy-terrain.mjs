#!/usr/bin/env node
// schema 1 bundleのESTN/ESTB(4ch float16)を、現行v3 wire(4ch uint8)の地形バイナリへ変換する。
// レイアウトはどちらも (nx, ny, nz, roughness)。入力の z<minZoom タイルは現行契約の
// 対象外なので書き出さない。
import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  EARTH_TILE_MIN_Z, EARTH_TERRAIN_BYTES, EARTH_TERRAIN_CHANNELS, EARTH_TERRAIN_FORMAT_VERSION,
  EARTH_TERRAIN_HEADER_BYTES, EARTH_TERRAIN_HEIGHT, EARTH_TERRAIN_SCALAR_UINT8,
  EARTH_TERRAIN_WIDTH,
} from './contract.mjs';

const LEGACY_FORMAT_VERSION = 1;
const LEGACY_SCALAR_FLOAT16 = 1;
const LEGACY_TERRAIN_BYTES = EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * EARTH_TERRAIN_CHANNELS * 2;
const LEGACY_PAYLOAD_BYTES = EARTH_TERRAIN_HEADER_BYTES + LEGACY_TERRAIN_BYTES;
const BASE_ROOT_COLUMNS = 2;
const BASE_ROOT_ROWS = 1;

// half→float変換のためsubarrayの切り出し先ではなく独立した整列済みバッファへ写す。
function alignedFloat16(payload) {
  const body = Buffer.from(payload.subarray(EARTH_TERRAIN_HEADER_BYTES));
  return new Float16Array(body.buffer, body.byteOffset, body.length / 2);
}

// v1 ESTNのヘッダを検査してタイルキーを返す。
function readLegacyEstnHeader(payload, expectedKey) {
  if (payload.byteLength !== LEGACY_PAYLOAD_BYTES) throw new Error(`legacy ESTN payload length mismatch: ${expectedKey.id}`);
  if (payload.toString('ascii', 0, 4) !== 'ESTN') throw new Error(`legacy ESTN magic mismatch: ${expectedKey.id}`);
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
  if (version !== LEGACY_FORMAT_VERSION || headerBytes !== EARTH_TERRAIN_HEADER_BYTES
    || width !== EARTH_TERRAIN_WIDTH || height !== EARTH_TERRAIN_HEIGHT || reserved !== 0
    || channels !== EARTH_TERRAIN_CHANNELS || scalar !== LEGACY_SCALAR_FLOAT16
    || dataBytes !== LEGACY_TERRAIN_BYTES || reserved2 !== 0
    || z !== expectedKey.z || x !== expectedKey.x || y !== expectedKey.y) {
    throw new Error(`legacy ESTN header mismatch: ${expectedKey.id}`);
  }
}

// v1 ESTN(f16x4)をv3 ESTN(u8x4)へ変換する。
function convertEstn(payload, key) {
  readLegacyEstnHeader(payload, key);
  const source = alignedFloat16(payload);
  const output = Buffer.alloc(EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
  output.write('ESTN', 0, 'ascii');
  output.writeUInt16LE(EARTH_TERRAIN_FORMAT_VERSION, 4); output.writeUInt16LE(EARTH_TERRAIN_HEADER_BYTES, 6);
  output.writeUInt16LE(EARTH_TERRAIN_WIDTH, 8); output.writeUInt16LE(EARTH_TERRAIN_HEIGHT, 10);
  output.writeUInt8(key.z, 12); output.writeUInt8(0, 13);
  output.writeUInt32LE(key.x, 14); output.writeUInt32LE(key.y, 18);
  output.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); output.writeUInt8(EARTH_TERRAIN_SCALAR_UINT8, 23);
  output.writeUInt32LE(EARTH_TERRAIN_BYTES, 24); output.writeUInt32LE(0, 28);
  const encodeNormal = (value) => Math.max(0, Math.min(255, Math.round((value * 0.5 + 0.5) * 255)));
  const encodeScalar = (value) => Math.max(0, Math.min(255, Math.round(value * 255)));
  for (let texel = 0; texel < source.length; texel += EARTH_TERRAIN_CHANNELS) {
    const offset = EARTH_TERRAIN_HEADER_BYTES + texel;
    output[offset] = encodeNormal(source[texel]);
    output[offset + 1] = encodeNormal(source[texel + 1]);
    output[offset + 2] = encodeNormal(source[texel + 2]);
    output[offset + 3] = encodeScalar(source[texel + 3]);
  }
  return output;
}

// v1 ESTB(2枚のz=0 ESTN)をv3 ESTBへ変換する。
function convertEstb(payload) {
  if (payload.byteLength !== EARTH_TERRAIN_HEADER_BYTES
    + BASE_ROOT_COLUMNS * BASE_ROOT_ROWS * LEGACY_PAYLOAD_BYTES) {
    throw new Error('legacy ESTB payload length mismatch');
  }
  if (payload.toString('ascii', 0, 4) !== 'ESTB') throw new Error('legacy ESTB magic mismatch');
  const tiles = [];
  for (let column = 0; column < BASE_ROOT_COLUMNS; column += 1) {
    const start = EARTH_TERRAIN_HEADER_BYTES + column * LEGACY_PAYLOAD_BYTES;
    tiles.push(convertEstn(payload.subarray(start, start + LEGACY_PAYLOAD_BYTES), { id: `0/${column}/0`, z: 0, x: column, y: 0 }));
  }
  const output = Buffer.alloc(EARTH_TERRAIN_HEADER_BYTES + Buffer.concat(tiles).length);
  output.write('ESTB', 0, 'ascii');
  output.writeUInt16LE(EARTH_TERRAIN_FORMAT_VERSION, 4); output.writeUInt16LE(EARTH_TERRAIN_HEADER_BYTES, 6);
  output.writeUInt16LE(EARTH_TERRAIN_WIDTH, 8); output.writeUInt16LE(EARTH_TERRAIN_HEIGHT, 10);
  output.writeUInt8(0, 12); output.writeUInt8(0, 13);
  output.writeUInt32LE(BASE_ROOT_COLUMNS, 14); output.writeUInt32LE(BASE_ROOT_ROWS, 18);
  output.writeUInt8(EARTH_TERRAIN_CHANNELS, 22); output.writeUInt8(EARTH_TERRAIN_SCALAR_UINT8, 23);
  output.writeUInt32LE(output.length - EARTH_TERRAIN_HEADER_BYTES, 24); output.writeUInt32LE(0, 28);
  Buffer.concat(tiles).copy(output, EARTH_TERRAIN_HEADER_BYTES);
  return output;
}

// 入力bundleの地形バイナリをすべてv3へ変換して出力へ書く。タイルキーの列挙を返す。
export async function convertLegacyTerrain({ inputRoot, outputRoot } = {}) {
  const input = resolve(inputRoot);
  const output = resolve(outputRoot);
  const keys = [];
  const tilesRoot = join(input, 'tiles');
  for (const zDir of await readdir(tilesRoot)) {
    const z = Number(zDir);
    if (!Number.isSafeInteger(z) || z < EARTH_TILE_MIN_Z) continue;
    for (const xDir of await readdir(join(tilesRoot, zDir))) {
      for (const name of await readdir(join(tilesRoot, zDir, xDir))) {
        const match = /^([0-9]+)\.bin\.gz$/.exec(name);
        if (match === null) continue;
        const key = { id: `${z}/${xDir}/${match[1]}`, z, x: Number(xDir), y: Number(match[1]) };
        const payload = gunzipSync(await readFile(join(tilesRoot, zDir, xDir, name)));
        const destination = join(output, 'tiles', zDir, xDir, name);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, gzipSync(convertEstn(payload, key), { mtime: 0 }));
        keys.push(key);
      }
    }
  }
  const base = gunzipSync(await readFile(join(input, 'base/earth.bin.gz')));
  await mkdir(join(output, 'base'), { recursive: true });
  await writeFile(join(output, 'base/earth.bin.gz'), gzipSync(convertEstb(base), { mtime: 0 }));
  return keys;
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const keys = await convertLegacyTerrain({
    inputRoot: args.get('--input') ?? '.earth-surface/bundle',
    outputRoot: args.get('--output') ?? '.earth-surface/bundle-v3',
  });
  console.log(`earth-surface:convert-legacy-terrain: ${keys.length} tiles + base`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => { console.error(`earth-surface:convert-legacy-terrain: ${error.message}`); process.exitCode = 1; });
}
