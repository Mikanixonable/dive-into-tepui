// 地表タイルのgzip、ESTNヘッダー、世代とキャンセル境界を検査する。
import * as assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import {
  EARTH_BASE_TERRAIN_HEIGHT,
  EARTH_BASE_TERRAIN_WIDTH,
} from '../../src/render/earth-surface-terrain-codec';
import {
  decodeEarthBaseTerrainPayload,
  decodeEarthTerrainPayload,
} from '../../src/render/earth-surface-terrain-codec';
import { decodeEarthSurfaceTile } from '../../src/render/earth-surface-tile-decode';
import { EarthSurfaceDecodeError } from '../../src/render/earth-surface-decode-errors';
import {
  EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES, EARTH_TERRAIN_HEIGHT, EARTH_TERRAIN_WIDTH,
} from '../../src/render/earth-surface-format';
import { earthTileKey } from '../../src/render/earth-surface-tile-key';
import { decodeEarthTerrainOffThread } from '../../src/render/earth-surface-terrain-worker-client';

const KEY = earthTileKey(5, 2, 1);

function terrainPayload(): Uint8Array {
  const payload = new Uint8Array(EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
  payload.set(new TextEncoder().encode('ESTN'), 0);
  const view = new DataView(payload.buffer);
  view.setUint16(4, 3, true); view.setUint16(6, 32, true);
  view.setUint16(8, EARTH_TERRAIN_WIDTH, true); view.setUint16(10, EARTH_TERRAIN_HEIGHT, true);
  view.setUint8(12, KEY.z); view.setUint8(13, 0);
  view.setUint32(14, KEY.x, true); view.setUint32(18, KEY.y, true);
  view.setUint8(22, 4); view.setUint8(23, 2); view.setUint32(24, EARTH_TERRAIN_BYTES, true); view.setUint32(28, 0, true);
  return payload;
}

function rootTerrainPayload(x: number): Uint8Array {
  const key = earthTileKey(0, x, 0);
  const payload = new Uint8Array(EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
  payload.set(new TextEncoder().encode('ESTN'), 0);
  const view = new DataView(payload.buffer);
  view.setUint16(4, 3, true); view.setUint16(6, 32, true);
  view.setUint16(8, EARTH_TERRAIN_WIDTH, true); view.setUint16(10, EARTH_TERRAIN_HEIGHT, true);
  view.setUint8(12, key.z); view.setUint8(13, 0);
  view.setUint32(14, key.x, true); view.setUint32(18, key.y, true);
  view.setUint8(22, 4); view.setUint8(23, 2); view.setUint32(24, EARTH_TERRAIN_BYTES, true); view.setUint32(28, 0, true);
  new Uint8Array(payload.buffer, EARTH_TERRAIN_HEADER_BYTES).fill(x === 0 ? 0x1111 : 0x2222);
  return payload;
}

function baseTerrainPayload(): Uint8Array {
  const first = rootTerrainPayload(0);
  const second = rootTerrainPayload(1);
  const payload = new Uint8Array(32 + first.length + second.length);
  payload.set(new TextEncoder().encode('ESTB'), 0);
  const view = new DataView(payload.buffer);
  view.setUint16(4, 3, true); view.setUint16(6, 32, true);
  view.setUint16(8, EARTH_TERRAIN_WIDTH, true); view.setUint16(10, EARTH_TERRAIN_HEIGHT, true);
  view.setUint8(12, 0); view.setUint8(13, 0);
  view.setUint32(14, 2, true); view.setUint32(18, 1, true);
  view.setUint8(22, 4); view.setUint8(23, 2); view.setUint32(24, first.length + second.length, true); view.setUint32(28, 0, true);
  payload.set(first, 32); payload.set(second, 32 + first.length);
  return payload;
}

function response(bytes: Uint8Array, contentType = 'application/octet-stream'): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { status: 200, headers: { 'content-type': contentType, 'content-length': String(bytes.length) } });
}

export function register(): void {
  test('earth decode: Worker非対応環境でも同じ地形復号契約を使う', async () => {
    const payload = terrainPayload();
    const result = await decodeEarthTerrainOffThread(gzipSync(payload), KEY, payload.length);
    assert.equal(result.length, EARTH_TERRAIN_BYTES);
    assert.equal(result[0], payload[EARTH_TERRAIN_HEADER_BYTES]);
  });

  test('earth decode: ESTNのヘッダーとキーを検査してnormal XYZ RGB + roughness A本文を返す', () => {
    const payload = terrainPayload();
    assert.equal(decodeEarthTerrainPayload(payload, KEY).length, EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * 4);
    assert.throws(() => decodeEarthTerrainPayload(payload, earthTileKey(1, 0, 0)), EarthSurfaceDecodeError);
    payload[0] = 0;
    assert.throws(() => decodeEarthTerrainPayload(payload, KEY), /magic/);
  });

  test('earth decode: ESTBの2枚のroot地形をbase用の経緯度画像へ連結する', () => {
    const result = decodeEarthBaseTerrainPayload(baseTerrainPayload());
    assert.equal(result.length, EARTH_BASE_TERRAIN_WIDTH * EARTH_BASE_TERRAIN_HEIGHT * 4);
    assert.equal(result[0], 0x11);
    assert.equal(result[(EARTH_BASE_TERRAIN_WIDTH - 1) * 4], 0x22);
  });

  test('earth decode: 色とgzip地形を同じ世代でatomically decodeする', async () => {
    const terrain = terrainPayload();
    const compressed = gzipSync(terrain);
    const calls: string[] = [];
    const result = await decodeEarthSurfaceTile({
      key: KEY, colorUrl: '/color.jpg', terrainUrl: '/terrain.bin.gz', generation: 7,
      fetchImpl: async (input) => { const url = String(input); calls.push(url); return url.endsWith('.jpg') ? response(new Uint8Array([0xff, 0xd8]), 'image/jpeg') : response(compressed); },
      decodeImage: async (bytes) => bytes,
    });
    assert.deepEqual(calls.sort(), ['/color.jpg', '/terrain.bin.gz']);
    assert.equal(result.generation, 7);
    assert.equal(result.terrain.length, EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * 4);
  });

  test('earth decode: 色デコード後のabortでImageBitmapを閉じる', async () => {
    const terrain = terrainPayload();
    const compressed = gzipSync(terrain);
    const controller = new AbortController();
    let closed = 0;
    const image = { close: () => { closed += 1; } };
    await assert.rejects(decodeEarthSurfaceTile({
      key: KEY, colorUrl: '/color.jpg', terrainUrl: '/terrain.bin.gz', generation: 7,
      signal: controller.signal,
      fetchImpl: async (input) => String(input).endsWith('.jpg')
        ? response(new Uint8Array([0xff, 0xd8]), 'image/jpeg') : response(compressed),
      decodeImage: async () => { controller.abort(); return image; },
    }), /aborted/);
    assert.equal(closed, 1);
  });

  test('earth decode: terrain本文の上限超過を公開前に拒否する', async () => {
    const terrain = gzipSync(terrainPayload());
    const fetchImpl = async (input: URL | RequestInfo) => response(String(input).endsWith('.jpg') ? new Uint8Array([1]) : terrain);
    await assert.rejects(decodeEarthSurfaceTile({
      key: KEY, colorUrl: 'color', terrainUrl: 'terrain', generation: 0, fetchImpl,
      decodeImage: async () => null, maxTerrainBytes: 1,
    }), /too large/);
  });

  test('earth decode: 上限超過で途中のresponse bodyをcancelする', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      cancel() { canceled = true; },
    });
    const fetchImpl = async (input: URL | RequestInfo) => String(input).endsWith('.jpg')
      ? response(new Uint8Array([1]), 'image/jpeg')
      : new Response(body, { status: 200 });
    await assert.rejects(decodeEarthSurfaceTile({
      key: KEY, colorUrl: 'color.jpg', terrainUrl: 'terrain.bin.gz', generation: 0, fetchImpl,
      decodeImage: async () => null, maxTerrainBytes: 1,
    }), /too large/);
    assert.equal(canceled, true);
  });
}
