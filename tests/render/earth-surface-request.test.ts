// 地表要求キューの独立した同時実行数、再試行、永久失敗、世代と破棄境界を検査する。
import * as assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import {
  EarthSurfaceTileRequestQueue,
} from '../../src/render/earth-surface-tile-queue';
import { EarthSurfaceTileSource } from '../../src/render/earth-surface-tile-source';
import { EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES } from '../../src/render/earth-surface-format';
import { earthTileKey } from '../../src/render/earth-surface-tile-key';

const COLOR = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const PAYLOAD_BYTES = EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES;

function terrain(key: ReturnType<typeof earthTileKey>): Uint8Array {
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  bytes.set(new TextEncoder().encode('ESTN'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 3, true); view.setUint16(6, 32, true);
  view.setUint16(8, 260, true); view.setUint16(10, 260, true);
  view.setUint8(12, key.z); view.setUint32(14, key.x, true); view.setUint32(18, key.y, true);
  view.setUint8(22, 4); view.setUint8(23, 2); view.setUint32(24, EARTH_TERRAIN_BYTES, true);
  return bytes;
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
  test('earth requests: 決定URLはz5から解決し、z4以下はbaseへ戻す', () => {
    const source = new EarthSurfaceTileSource(
      'https://example.test/earth/tiles/{z}/{x}/{y}.jpg',
      'https://example.test/earth/tiles/{z}/{x}/{y}.bin.gz',
    );
    assert.equal(source.descriptorFor(earthTileKey(4, 0, 0)), null);
    assert.deepEqual(source.urlFor(earthTileKey(5, 3, 7)), {
      color: 'https://example.test/earth/tiles/5/3/7.jpg',
      terrain: 'https://example.test/earth/tiles/5/3/7.bin.gz',
    });
  });

  test('earth requests: fetchImplをreceiverなしで決定URLの色・地形へ使う', async () => {
    const key = earthTileKey(5, 0, 0);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async function (this: unknown, input, _init) {
      if (this !== undefined) throw new Error('fetch receiver must be undefined');
      const url = String(input);
      calls.push(url);
      return url.endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    };
    const source = new EarthSurfaceTileSource(
      'https://example.test/earth/tiles/{z}/{x}/{y}.jpg',
      'https://example.test/earth/tiles/{z}/{x}/{y}.bin.gz',
    );
    const queue = new EarthSurfaceTileRequestQueue(source, { fetchImpl, decodeImage: async (bytes) => bytes });

    const payload = await queue.request(key, 4);
    assert.equal(payload.key.z, key.z);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.sort(), [
      'https://example.test/earth/tiles/5/0/0.bin.gz',
      'https://example.test/earth/tiles/5/0/0.jpg',
    ]);
    queue.release(key, 4);
  });

  test('earth requests: HTTPとdecodeのメトリクスは決定URLごとに記録する', async () => {
    const keys = [earthTileKey(5, 0, 0), earthTileKey(5, 1, 0), earthTileKey(5, 2, 0)];
    let activeHttp = 0;
    let maxHttp = 0;
    let activeDecode = 0;
    let maxDecode = 0;
    const source = new EarthSurfaceTileSource(
      'https://example.test/tiles/{z}/{x}/{y}.jpg', 'https://example.test/tiles/{z}/{x}/{y}.bin.gz',
    );
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
    const key = earthTileKey(5, 0, 0);
    const source = new EarthSurfaceTileSource(
      'https://example.test/tiles/{z}/{x}/{y}.jpg', 'https://example.test/tiles/{z}/{x}/{y}.bin.gz',
    );
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

  test('earth requests: 404は再試行せず版内永久失敗にする', async () => {
    const notFound = earthTileKey(5, 0, 0);
    const notFoundSource = new EarthSurfaceTileSource(
      'https://example.test/tiles/{z}/{x}/{y}.jpg', 'https://example.test/tiles/{z}/{x}/{y}.bin.gz',
    );
    let notFoundCalls = 0;
    const notFoundQueue = new EarthSurfaceTileRequestQueue(notFoundSource, {
      fetchImpl: async () => { notFoundCalls++; return response(new Uint8Array(), 404); }, decodeImage: async () => null,
    });
    await assert.rejects(notFoundQueue.request(notFound, 0), /HTTP 404/);
    await assert.rejects(notFoundQueue.request(notFound, 0), /HTTP 404/);
    assert.equal(notFoundCalls, 2);
    assert.equal(notFoundQueue.metrics.retries, 0);
  });

  test('earth requests: generationのabortとdisposeは待機中の本文を公開しない', async () => {
    const key = earthTileKey(5, 0, 0);
    const source = new EarthSurfaceTileSource(
      'https://example.test/tiles/{z}/{x}/{y}.jpg', 'https://example.test/tiles/{z}/{x}/{y}.bin.gz',
    );
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

  test('earth requests: 外部abortはtimeout再試行として扱わない', async () => {
    const key = earthTileKey(5, 0, 0);
    const source = new EarthSurfaceTileSource(
      'https://example.test/tiles/{z}/{x}/{y}.jpg', 'https://example.test/tiles/{z}/{x}/{y}.bin.gz',
    );
    const started = deferred();
    let calls = 0;
    const queue = new EarthSurfaceTileRequestQueue(source, {
      timeoutMs: 1,
      fetchImpl: async (_input, init) => {
        calls++;
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      },
      decodeImage: async () => null,
    });
    const controller = new AbortController();
    const promise = queue.request(key, 1, controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(promise, /aborted/i);
    assert.equal(queue.metrics.retries, 0);
    assert.equal(calls, 2);
  });
}
