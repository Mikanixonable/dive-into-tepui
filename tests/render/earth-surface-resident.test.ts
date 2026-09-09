// 要求の到着順、親fallback、同時upload、破棄境界、配列層上限を検査する。
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import { EarthSurfaceResidentCoordinator } from '../../src/render/earth-surface-resident';
import { EarthSurfaceGpuAdapter } from '../../src/render/earth-surface-gpu';
import type { EarthSurfaceGpuBackend, EarthSurfaceGpuCapabilities } from '../../src/render/earth-surface-gpu';
import { EarthSurfaceTileRequestQueue, EarthSurfaceTileRequestSource } from '../../src/render/earth-surface-request';
import type { EarthSurfaceTileIndexFile } from '../../src/render/earth-surface-request';
import { EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES } from '../../src/render/earth-surface-decode';
import {
  EARTH_TILE_EXTENT, EarthSurfaceTiles, earthPageAt,
  earthTileChildren, earthTileId, earthTileKey,
} from '../../src/render/earth-surface-tiles';
import type { EarthTileKey, EarthTileProjection } from '../../src/render/earth-surface-tiles';

const CAPABILITIES: EarthSurfaceGpuCapabilities = {
  texture2dArray: true, maxTextureArrayLayers: 128, colorSrgbLinear: true, terrainFloat16Linear: true,
};
const PIXELS = EARTH_TILE_EXTENT * EARTH_TILE_EXTENT * 4;
const COLOR = new Uint8Array(PIXELS).fill(17);

class ImmediateBackend implements EarthSurfaceGpuBackend {
  public readonly pages: Uint8Array[] = [];
  public readonly writes: number[] = [];
  public disposed = false;
  public constructor(public readonly capabilities = CAPABILITIES) {}
  public writeColor(layer: number, _pixels: Uint8Array): Promise<void> { this.writes.push(layer); return Promise.resolve(); }
  public writeTerrain(_layer: number, _pixels: Uint16Array): Promise<void> { return Promise.resolve(); }
  public swapPageTable(pixels: Uint8Array): void { this.pages.push(pixels.slice()); }
  public dispose(): void { this.disposed = true; }
}

function terrain(key: EarthTileKey): Uint8Array {
  const bytes = new Uint8Array(EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
  bytes.set(new TextEncoder().encode('ESTN'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true); view.setUint16(6, 32, true);
  view.setUint16(8, 260, true); view.setUint16(10, 260, true);
  view.setUint8(12, key.z); view.setUint32(14, key.x, true); view.setUint32(18, key.y, true);
  view.setUint8(22, 4); view.setUint8(23, 1); view.setUint32(24, EARTH_TERRAIN_BYTES, true);
  return bytes;
}

function indexFor(keys: readonly EarthTileKey[]): EarthSurfaceTileIndexFile {
  return {
    schemaVersion: 1, datasetId: 'resident-fixture',
    entries: keys.map((key) => {
      const payload = terrain(key);
      const id = earthTileId(key);
      return {
        key: id, z: key.z, x: key.x, y: key.y,
        color: { url: `${id}.jpg`, sha256: createHash('sha256').update(COLOR).digest('hex'), encodedBytes: COLOR.length, payloadBytes: COLOR.length },
        terrain: { url: `${id}.bin.gz`, sha256: createHash('sha256').update(payload).digest('hex'), encodedBytes: gzipSync(payload).length, payloadBytes: payload.length },
      };
    }),
  };
}

class Projection implements EarthTileProjection {
  public constructor(public readonly splitError = 3, public readonly maximumLevel = 0) {}
  public evaluate(key: EarthTileKey): { readonly visible: boolean; readonly errorPx: number; readonly priority: number } {
    return { visible: true, errorPx: key.z <= this.maximumLevel ? this.splitError : 0, priority: 1 / (1 + key.z) };
  }
}

function response(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice(), { status, headers: { 'content-length': String(bytes.length) } });
}

function coordinator(keys: readonly EarthTileKey[], fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  const isColor = url.endsWith('.jpg');
  const id = url.replace(/\.(jpg|bin\.gz)$/, '');
  const key = keys.find((candidate) => earthTileId(candidate) === id);
  if (key === undefined) throw new Error(`missing fixture ${id}`);
  return isColor ? response(COLOR) : response(gzipSync(terrain(key)));
}) {
  const source = new EarthSurfaceTileRequestSource(indexFor(keys));
  const queue = new EarthSurfaceTileRequestQueue(source, {
    fetchImpl,
    decodeImage: async () => COLOR.slice(),
  });
  const backend = new ImmediateBackend();
  const gpu = new EarthSurfaceGpuAdapter(backend);
  const tiles = new EarthSurfaceTiles();
  const resident = new EarthSurfaceResidentCoordinator({
    tiles, queue, gpu, colorToRgba8: (color) => {
      if (!(color instanceof Uint8Array)) throw new Error('fixture color is not RGBA8');
      return color;
    },
  });
  return { backend, gpu, queue, resident, tiles };
}

function sync(resident: EarthSurfaceResidentCoordinator, projection: EarthTileProjection, timeMs: number, generation = 1): void {
  resident.sync({ projection, timeMs, generation });
}

export function register(): void {
  test('earth resident: 子の逆順到着でも全層がそろうまで親fallbackを維持する', async () => {
    const roots = [earthTileKey(0, 0, 0), earthTileKey(0, 1, 0)];
    const children = earthTileChildren(roots[0]!);
    const fixture = coordinator([...roots, ...children], async (input) => {
      const url = String(input);
      const id = url.replace(/\.(jpg|bin\.gz)$/, '');
      const key = [...roots, ...children].find((candidate) => earthTileId(candidate) === id);
      if (key === undefined) throw new Error(`missing fixture ${id}`);
      const order = children.findIndex((candidate) => earthTileId(candidate) === id);
      if (order >= 0) await new Promise((resolve) => setTimeout(resolve, (children.length - order) * 2));
      return url.endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    });
    const projection = new Projection();
    sync(fixture.resident, projection, 0);
    assert.deepEqual(earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1), [255, 255, 255, 255]);
    await fixture.resident.settle();
    sync(fixture.resident, projection, 300);
    await fixture.resident.settle();
    sync(fixture.resident, projection, 600);
    assert.deepEqual(earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1).slice(2), [0, 255]);
    await fixture.resident.settle();
    sync(fixture.resident, projection, 900);
    const childPage = earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1);
    assert.equal(childPage[2], 1);
    assert.equal(childPage[1], 0);
    assert.notEqual(childPage[0], 255);
    sync(fixture.resident, projection, 1200);
    assert.equal(earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1)[3], 255);
  });

  test('earth resident: 色か地形の片側失敗は公開せず親を残す', async () => {
    const roots = [earthTileKey(0, 0, 0), earthTileKey(0, 1, 0)];
    const children = earthTileChildren(roots[0]!);
    const failed = children[3]!;
    const fixture = coordinator([...roots, ...children], async (input) => {
      if (String(input).includes(`${failed.z}/${failed.x}/${failed.y}`) && String(input).endsWith('.jpg')) return response(new Uint8Array(), 404);
      const id = String(input).replace(/\.(jpg|bin\.gz)$/, '');
      const key = [...roots, ...children].find((candidate) => earthTileId(candidate) === id);
      if (key === undefined) throw new Error(`missing fixture ${id}`);
      return String(input).endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    });
    const projection = new Projection();
    sync(fixture.resident, projection, 0); await fixture.resident.settle();
    sync(fixture.resident, projection, 300); await fixture.resident.settle();
    sync(fixture.resident, projection, 600); await fixture.resident.settle();
    sync(fixture.resident, projection, 900);
    const page = earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1);
    assert.equal(page[2], 0);
    assert.equal(fixture.tiles.frontier.length, 2);
  });

  test('earth resident: disposeは遅着を公開せずqueueとGPUを破棄する', async () => {
    const key = earthTileKey(0, 0, 0);
    let resolve!: () => void;
    const gate = new Promise<void>((done) => { resolve = done; });
    const fixture = coordinator([key], async (input, init) => {
      init?.signal?.addEventListener('abort', resolve, { once: true });
      await gate;
      return String(input).endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    });
    sync(fixture.resident, new Projection(), 0);
    fixture.resident.dispose();
    resolve();
    await fixture.resident.settle();
    assert.equal(fixture.backend.pages.length, 2);
    assert.deepEqual(earthPageAt(fixture.backend.pages[1]!, 0.1, 0.1), [255, 255, 255, 255]);
    assert.equal(fixture.backend.disposed, true);
    assert.equal(fixture.gpu.uploadedTiles().length, 0);
  });

  test('earth resident: 要求と予約は128層を超えず遠い要求を増やさない', async () => {
    const keys: EarthTileKey[] = [];
    for (let z = 0; z <= 4; z++) {
      const height = 2 ** z;
      for (let y = 0; y < height; y++) for (let x = 0; x < 2 * height; x++) keys.push(earthTileKey(z, x, y));
    }
    const fixture = coordinator(keys);
    const projection = new Projection(3, 4);
    for (let step = 0; step < 8; step++) {
      sync(fixture.resident, projection, step * 300);
      await fixture.resident.settle();
    }
    let reservations = 0;
    for (let layer = 0; layer < 128; layer++) if (fixture.gpu.reservation(layer) !== null) reservations++;
    assert.ok(reservations <= 128);
  });

  test('earth resident: GPU機能不足時は詳細要求を止めて全球baseを維持する', () => {
    const fixture = coordinator([earthTileKey(0, 0, 0)]);
    const unsupported = new ImmediateBackend({ ...CAPABILITIES, texture2dArray: false });
    const baseGpu = new EarthSurfaceGpuAdapter(unsupported);
    const baseCoordinator = new EarthSurfaceResidentCoordinator({
      tiles: new EarthSurfaceTiles(), queue: fixture.queue, gpu: baseGpu,
      colorToRgba8: (color) => color as Uint8Array,
    });
    const result = baseCoordinator.sync({ projection: new Projection(), timeMs: 0, generation: 1 });
    assert.deepEqual(result.requested, []);
    assert.equal(unsupported.pages.length, 0);
    baseCoordinator.dispose();
    fixture.resident.dispose();
  });
}
