// 地表タイルのgzip、ESTNヘッダー、hash、世代とキャンセル境界を検査する。
import * as assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import {
  EARTH_TERRAIN_BYTES,
  EARTH_TERRAIN_HEADER_BYTES,
  EARTH_TERRAIN_HEIGHT,
  EARTH_TERRAIN_WIDTH,
  decodeEarthSurfaceTile,
  decodeEarthTerrainPayload,
  EarthSurfaceDecodeError,
} from '../../src/render/earth-surface-decode';
import { earthTileKey } from '../../src/render/earth-surface-tiles';

const KEY = earthTileKey(1, 2, 1);

function terrainPayload(): Uint8Array {
  const payload = new Uint8Array(EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
  payload.set(new TextEncoder().encode('ESTN'), 0);
  const view = new DataView(payload.buffer);
  view.setUint16(4, 1, true); view.setUint16(6, 32, true);
  view.setUint16(8, EARTH_TERRAIN_WIDTH, true); view.setUint16(10, EARTH_TERRAIN_HEIGHT, true);
  view.setUint8(12, KEY.z); view.setUint8(13, 0);
  view.setUint32(14, KEY.x, true); view.setUint32(18, KEY.y, true);
  view.setUint8(22, 4); view.setUint8(23, 1); view.setUint32(24, EARTH_TERRAIN_BYTES, true); view.setUint32(28, 0, true);
  return payload;
}

function response(bytes: Uint8Array, contentType = 'application/octet-stream'): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { status: 200, headers: { 'content-type': contentType, 'content-length': String(bytes.length) } });
}

export function register(): void {
  test('earth decode: ESTNのヘッダーとキーを検査してbinary16本文を返す', () => {
    const payload = terrainPayload();
    assert.equal(decodeEarthTerrainPayload(payload, KEY).length, EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * 4);
    assert.throws(() => decodeEarthTerrainPayload(payload, earthTileKey(1, 0, 0)), EarthSurfaceDecodeError);
    payload[0] = 0;
    assert.throws(() => decodeEarthTerrainPayload(payload, KEY), /magic/);
  });

  test('earth decode: 色とgzip地形を同じ世代でatomically decodeする', async () => {
    const terrain = terrainPayload();
    const compressed = gzipSync(terrain);
    const calls: string[] = [];
    const result = await decodeEarthSurfaceTile({
      key: KEY, colorUrl: '/color.jpg', terrainUrl: '/terrain.bin.gz', generation: 7,
      fetchImpl: async (input) => { const url = String(input); calls.push(url); return url.endsWith('.jpg') ? response(new Uint8Array([0xff, 0xd8]), 'image/jpeg') : response(compressed); },
      decodeImage: async (bytes) => bytes,
      expectedTerrainSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', terrain.slice().buffer))]
        .map((value) => value.toString(16).padStart(2, '0')).join(''),
    });
    assert.deepEqual(calls.sort(), ['/color.jpg', '/terrain.bin.gz']);
    assert.equal(result.generation, 7);
    assert.equal(result.terrain.length, EARTH_TERRAIN_WIDTH * EARTH_TERRAIN_HEIGHT * 4);
  });

  test('earth decode: hash不一致と上限超過を公開前に拒否する', async () => {
    const terrain = gzipSync(terrainPayload());
    const fetchImpl = async (input: URL | RequestInfo) => response(String(input).endsWith('.jpg') ? new Uint8Array([1]) : terrain);
    await assert.rejects(decodeEarthSurfaceTile({
      key: KEY, colorUrl: 'color', terrainUrl: 'terrain', generation: 0, fetchImpl,
      decodeImage: async () => null, expectedTerrainSha256: '0'.repeat(64),
    }), /hash mismatch/);
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
