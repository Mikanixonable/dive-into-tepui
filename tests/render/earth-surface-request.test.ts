// 地表要求キューの独立した同時実行数、再試行、永久失敗、世代と破棄境界を検査する。
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import {
  EarthSurfaceTileRequestQueue, EarthSurfaceTileRequestSource,
} from '../../src/render/earth-surface-request';
import { EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES } from '../../src/render/earth-surface-decode';
import { earthTileKey } from '../../src/render/earth-surface-tiles';
import type { EarthSurfaceTileIndexFile } from '../../src/render/earth-surface-request';

const COLOR = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const COLOR_HASH = createHash('sha256').update(COLOR).digest('hex');
const PAYLOAD_BYTES = EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES;

function terrain(key: ReturnType<typeof earthTileKey>): Uint8Array {
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  bytes.set(new TextEncoder().encode('ESTN'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 2, true); view.setUint16(6, 32, true);
  view.setUint16(8, 260, true); view.setUint16(10, 260, true);
  view.setUint8(12, key.z); view.setUint32(14, key.x, true); view.setUint32(18, key.y, true);
  view.setUint8(22, 4); view.setUint8(23, 2); view.setUint32(24, EARTH_TERRAIN_BYTES, true);
  return bytes;
}

function indexFor(keys: readonly ReturnType<typeof earthTileKey>[], wrongHash = false): EarthSurfaceTileIndexFile {
  return {
    schemaVersion: 2, datasetId: 'fixture',
    entries: keys.map((key) => {
      const payload = terrain(key);
      const compressed = gzipSync(payload);
      const id = `${key.z}/${key.x}/${key.y}`;
      return {
        key: id, z: key.z, x: key.x, y: key.y,
        color: { url: `tiles/${id}.jpg`, sha256: wrongHash ? '0'.repeat(64) : COLOR_HASH, encodedBytes: COLOR.length, payloadBytes: COLOR.length },
        terrain: { url: `tiles/${id}.bin.gz`, sha256: createHash('sha256').update(payload).digest('hex'), encodedBytes: compressed.length, payloadBytes: payload.length },
      };
    }),
  };
}

function response(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice(), { status, headers: { 'content-length': String(bytes.length) } });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function register(): void {
  test('earth requests: z3以下の詳細tile-indexを拒否し、z4から受け付ける', () => {
    assert.throws(
      () => new EarthSurfaceTileRequestSource(indexFor([earthTileKey(3, 0, 0)])),
      /Invalid tile-index key level/,
    );
    assert.doesNotThrow(() => new EarthSurfaceTileRequestSource(indexFor([earthTileKey(4, 0, 0)])));
  });

  test('earth requests: fetchImplをreceiverなしでindexと色・地形へ使う', async () => {
    const key = earthTileKey(4, 0, 0);
    const index = indexFor([key]);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async function (this: unknown, input, _init) {
      if (this !== undefined) throw new Error('fetch receiver must be undefined');
      const url = String(input);
      calls.push(url);
      if (url.endsWith('tile-index.json')) return new Response(JSON.stringify(index));
      return url.endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    };
    const source = new EarthSurfaceTileRequestSource({
      tileIndexUrl: 'https://example.test/earth/tile-index.json',
      baseUrl: 'https://example.test/earth/', fetchImpl,
    });
    const queue = new EarthSurfaceTileRequestQueue(source, { fetchImpl, decodeImage: async (bytes) => bytes });

    await source.ready();
    const payload = await queue.request(key, 4);
    assert.equal(payload.key.z, key.z);
    assert.equal(calls[0], 'https://example.test/earth/tile-index.json');
    assert.equal(calls.length, 3);
    assert.ok(calls.some((url) => url.endsWith('.jpg')));
    assert.ok(calls.some((url) => url.endsWith('.bin.gz')));
    queue.release(key, 4);
  });

  test('earth requests: tile-indexを一度だけ解決し、HTTP6とdecode2を別に数える', async () => {
    const keys = [earthTileKey(4, 0, 0), earthTileKey(4, 1, 0), earthTileKey(4, 2, 0)];
    const index = indexFor(keys);
    let indexFetches = 0;
    let activeHttp = 0;
    let maxHttp = 0;
    let activeDecode = 0;
    let maxDecode = 0;
    const source = new EarthSurfaceTileRequestSource(index);
    const queue = new EarthSurfaceTileRequestQueue(source, {
      fetchImpl: async (input) => {
        activeHttp++; maxHttp = Math.max(maxHttp, activeHttp);
        await Promise.resolve();
        activeHttp--;
        const url = String(input);
        return url.endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(keys.find((key) => url.includes(`${key.z}/${key.x}/${key.y}`))!)));
      },
      decodeImage: async (bytes) => {
        activeDecode++; maxDecode = Math.max(maxDecode, activeDecode);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeDecode--; return bytes;
      },
    });
    const sourceWithIndexFetch = new EarthSurfaceTileRequestSource({ tileIndexUrl: 'https://example.test/tile-index.json', fetchImpl: async () => {
      indexFetches++; return new Response(JSON.stringify(index));
    }, baseUrl: 'https://example.test/' });
    await sourceWithIndexFetch.ready();
    await sourceWithIndexFetch.ready();
    assert.equal(indexFetches, 1);
    const results = await Promise.all(keys.map((key) => queue.request(key, 3)));
    assert.equal(results.length, 3);
    assert.ok(maxHttp <= 6);
    assert.ok(maxDecode <= 2);
    assert.equal(queue.metrics.decodeStarted, 3);
    assert.ok(queue.metrics.events.filter((event) => event.resource === 'http')
      .every((event) => event.generation === 3));
    for (const key of keys) queue.release(key, 3);
    assert.equal(queue.metrics.waitingReleased, 3);
  });

  test('earth requests: 408/429/5xxとnetworkだけを最大2回再試行する', async () => {
    const key = earthTileKey(4, 0, 0);
    const source = new EarthSurfaceTileRequestSource(indexFor([key]));
    let colorAttempts = 0;
    const queue = new EarthSurfaceTileRequestQueue(source, {
      fetchImpl: async (input) => {
        if (String(input).endsWith('.jpg') && colorAttempts++ < 2) return response(new Uint8Array(), 503);
        return String(input).endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
      }, decodeImage: async (bytes) => bytes,
    });
    await queue.request(key, 11);
    assert.equal(queue.metrics.retries, 2);
    assert.equal(queue.metrics.failures.size, 0);
    queue.release(key, 11);
  });

  test('earth requests: 404とhash不一致は再試行せず版内永久失敗にする', async () => {
    const notFound = earthTileKey(4, 0, 0);
    const notFoundSource = new EarthSurfaceTileRequestSource(indexFor([notFound]));
    let notFoundCalls = 0;
    const notFoundQueue = new EarthSurfaceTileRequestQueue(notFoundSource, {
      fetchImpl: async () => { notFoundCalls++; return response(new Uint8Array(), 404); }, decodeImage: async () => null,
    });
    await assert.rejects(notFoundQueue.request(notFound, 0), /HTTP 404/);
    await assert.rejects(notFoundQueue.request(notFound, 0), /HTTP 404/);
    assert.equal(notFoundCalls, 2);
    assert.equal(notFoundQueue.metrics.retries, 0);

    const invalid = earthTileKey(4, 1, 0);
    const invalidQueue = new EarthSurfaceTileRequestQueue(new EarthSurfaceTileRequestSource(indexFor([invalid], true)), {
      fetchImpl: async (input) => String(input).endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(invalid))),
      decodeImage: async (bytes) => bytes,
    });
    await assert.rejects(invalidQueue.request(invalid, 1), /color hash mismatch/);
    assert.equal(invalidQueue.metrics.retries, 0);

    const mismatchSource = new EarthSurfaceTileRequestSource({
      tileIndexUrl: 'https://example.test/tile-index.json', expectedDatasetId: 'other',
      fetchImpl: async () => new Response(JSON.stringify(indexFor([invalid]))),
    });
    await assert.rejects(mismatchSource.ready(), /datasetId mismatch/);
    const validUrlIndex = indexFor([invalid]);
    const invalidUrlIndex = {
      ...validUrlIndex,
      entries: validUrlIndex.entries.map((entry) => ({
        ...entry, color: { ...entry.color, url: 'https://evil.test/tile.jpg' },
      })),
    };
    assert.throws(() => new EarthSurfaceTileRequestSource(invalidUrlIndex), /invalid URL/);
  });

  test('earth requests: generationのabortとdisposeは待機中の本文を公開しない', async () => {
    const key = earthTileKey(4, 0, 0);
    const source = new EarthSurfaceTileRequestSource(indexFor([key]));
    const started = deferred();
    const gate = deferred();
    let aborted = false;
    const queue = new EarthSurfaceTileRequestQueue(source, {
      fetchImpl: async (_input, init) => {
        started.resolve();
        init?.signal?.addEventListener('abort', () => { aborted = true; gate.resolve(); }, { once: true });
        await gate.promise;
        throw new DOMException('aborted', 'AbortError');
      }, decodeImage: async () => null,
    });
    const promise = queue.request(key, 8);
    await started.promise;
    queue.dispose();
    await assert.rejects(promise, /aborted|disposed/i);
    assert.equal(aborted, true);
    assert.equal(queue.metrics.waitingReserved, 0);
    assert.equal(queue.metrics.waitingReleased, 0);
    await assert.rejects(queue.request(key, 9), /disposed/i);
  });
}
