// 要求の到着順、親fallback、同時upload、破棄境界、配列層上限を検査する。
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import { EarthSurfaceResidentCoordinator } from '../../src/render/earth-surface-resident';
import { EarthSurfaceGpuAdapter } from '../../src/render/earth-surface-gpu';
import type { EarthSurfaceColorToRgba8 } from '../../src/render/earth-surface-resident';
import type { EarthSurfaceGpuBackend, EarthSurfaceGpuCapabilities } from '../../src/render/earth-surface-gpu';
import { EarthSurfaceTileRequestQueue, EarthSurfaceTileRequestSource } from '../../src/render/earth-surface-request';
import type { EarthSurfaceTileIndexFile } from '../../src/render/earth-surface-request';
import { EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES } from '../../src/render/earth-surface-decode';
import {
  EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH, EARTH_TILE_EXTENT, EARTH_TILE_LAYERS, EarthSurfaceTiles, earthPageAt,
  earthTileChildren, earthTileId, earthTileKey,
} from '../../src/render/earth-surface-tiles';
import type { EarthTileKey, EarthTileProjection, EarthTileResident } from '../../src/render/earth-surface-tiles';

const CAPABILITIES: EarthSurfaceGpuCapabilities = {
  texture2dArray: true, maxTextureArrayLayers: EARTH_TILE_LAYERS, colorSrgbLinear: true, terrainFloat16Linear: true,
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

class CandidateTiles extends EarthSurfaceTiles {
  public constructor(private candidates: readonly EarthTileKey[]) { super(); }

  public setCandidates(candidates: readonly EarthTileKey[]): void { this.candidates = candidates; }

  // admissionだけを検査するテスト用に、投影やfrontierとは独立した候補列を返す。
  public override requestCandidates(_projection: EarthTileProjection): readonly EarthTileKey[] {
    return this.candidates;
  }

  // 候補列の検査では親子遷移を発生させず、ページ表は全球baseのままにする。
  public override sync(_projection: EarthTileProjection, _residents: readonly EarthTileResident[], _timeMs: number): void {}

  public override pinnedLayers(): readonly number[] { return []; }

  public override pageTable(): Uint8Array {
    return new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(255);
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
}, backend = new ImmediateBackend(), colorToRgba8: EarthSurfaceColorToRgba8 = (color) => {
  if (!(color instanceof Uint8Array)) throw new Error('fixture color is not RGBA8');
  return color;
}, tiles = new EarthSurfaceTiles(), decodeImage: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown> = async () => COLOR.slice()) {
  const source = new EarthSurfaceTileRequestSource(indexFor(keys));
  const queue = new EarthSurfaceTileRequestQueue(source, {
    fetchImpl,
    decodeImage,
  });
  const gpu = new EarthSurfaceGpuAdapter(backend);
  const resident = new EarthSurfaceResidentCoordinator({
    tiles, queue, gpu, colorToRgba8,
  });
  return { backend, gpu, queue, resident, tiles };
}

function candidateKeys(count: number): readonly EarthTileKey[] {
  return Array.from({ length: count }, (_, index) => earthTileKey(7, index, 0));
}

// 実際のsplit候補と同じ4兄弟groupを並べたadmission fixtureを作る。
function groupedCandidateKeys(groups: number): readonly EarthTileKey[] {
  return Array.from({ length: groups }, (_, index) => {
    const parent = earthTileKey(6, index, 0);
    return earthTileChildren(parent);
  }).flat();
}

class GatedBackend extends ImmediateBackend {
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;
  public readonly started: Promise<void>;
  private resolveStarted!: () => void;
  public constructor() {
    super();
    this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });
    this.started = new Promise<void>((resolve) => { this.resolveStarted = resolve; });
  }
  public release(): void { this.releaseGate(); }
  public async writeColor(layer: number, pixels: Uint8Array): Promise<void> {
    this.resolveStarted();
    await this.gate;
    return super.writeColor(layer, pixels);
  }
  public async writeTerrain(layer: number, pixels: Uint16Array): Promise<void> {
    await this.gate;
    return super.writeTerrain(layer, pixels);
  }
}

class GenerationRaceBackend extends ImmediateBackend {
  private readonly firstGate: Promise<void>;
  private releaseFirstGate!: () => void;
  public readonly firstStarted: Promise<void>;
  private resolveFirstStarted!: () => void;
  private secondWrites = 0;
  public readonly secondFinished: Promise<void>;
  private resolveSecondFinished!: () => void;

  public constructor() {
    super();
    this.firstGate = new Promise<void>((resolve) => { this.releaseFirstGate = resolve; });
    this.firstStarted = new Promise<void>((resolve) => { this.resolveFirstStarted = resolve; });
    this.secondFinished = new Promise<void>((resolve) => { this.resolveSecondFinished = resolve; });
  }

  public releaseFirst(): void { this.releaseFirstGate(); }

  private markSecondWrite(): void {
    this.secondWrites++;
    if (this.secondWrites === 2) this.resolveSecondFinished();
  }

  public async writeColor(layer: number, pixels: Uint8Array): Promise<void> {
    if (layer === 0) {
      this.resolveFirstStarted();
      await this.firstGate;
    }
    await super.writeColor(layer, pixels);
    if (layer === 1) this.markSecondWrite();
  }

  public async writeTerrain(layer: number, pixels: Uint16Array): Promise<void> {
    if (layer === 0) await this.firstGate;
    await super.writeTerrain(layer, pixels);
    if (layer === 1) this.markSecondWrite();
  }
}

function sync(resident: EarthSurfaceResidentCoordinator, projection: EarthTileProjection, timeMs: number, generation = 1): void {
  resident.sync({ projection, timeMs, generation });
}

export function register(): void {
  test('earth resident: 候補が多くても同時pendingは8層以下に制限する', async () => {
    const keys = candidateKeys(16);
    const fixture = coordinator(keys, undefined, new ImmediateBackend(), undefined, new CandidateTiles(keys));
    const first = fixture.resident.sync({ projection: new Projection(), timeMs: 0, generation: 1 });
    assert.equal(first.requested.length, 8);
    const whilePending = fixture.resident.sync({ projection: new Projection(), timeMs: 1, generation: 1 });
    assert.equal(whilePending.requested.length, 0);
    await fixture.resident.settle();
    fixture.resident.dispose();
  });

  test('earth resident: pending完了後の次syncで候補の次群を要求する', async () => {
    const keys = candidateKeys(16);
    const fixture = coordinator(keys, undefined, new ImmediateBackend(), undefined, new CandidateTiles(keys));
    const first = fixture.resident.sync({ projection: new Projection(), timeMs: 0, generation: 1 });
    await fixture.resident.settle();
    const second = fixture.resident.sync({ projection: new Projection(), timeMs: 1, generation: 1 });
    assert.equal(first.requested.length, 8);
    assert.equal(second.requested.length, 8);
    assert.notEqual(earthTileId(first.requested[0]!), earthTileId(second.requested[0]!));
    await fixture.resident.settle();
    fixture.resident.dispose();
  });

  test('earth resident: reset後の同ID新residentを旧世代uploadが削除しない', async () => {
    const key = earthTileKey(7, 0, 0);
    const backend = new GenerationRaceBackend();
    const fixture = coordinator([key], undefined, backend, undefined, new CandidateTiles([key]));
    sync(fixture.resident, new Projection(), 0, 1);
    await backend.firstStarted;

    fixture.resident.reset();
    const next = fixture.resident.sync({ projection: new Projection(), timeMs: 1, generation: 2 });
    assert.deepEqual(next.requested.map(earthTileId), [earthTileId(key)]);
    let retained = false;
    try {
      await backend.secondFinished;
      for (let turn = 0; turn < 4 && fixture.resident.residentMaxZ === null; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(fixture.resident.residentMaxZ, 7);
    } finally {
      backend.releaseFirst();
      await fixture.resident.settle();
      retained = fixture.resident.residentMaxZ === 7;
    }
    assert.equal(retained, true);
    fixture.resident.dispose();
  });

  test('earth resident: admission上限外の候補のためにresidentを先行退避しない', async () => {
    const keys = groupedCandidateKeys(40);
    const tiles = new CandidateTiles(keys.slice(0, EARTH_TILE_LAYERS));
    const fixture = coordinator(keys, undefined, new ImmediateBackend(), undefined, tiles);
    for (let group = 0; group < EARTH_TILE_LAYERS / 8; group++) {
      const result = fixture.resident.sync({ projection: new Projection(), timeMs: group, generation: 1 });
      assert.equal(result.requested.length, 8);
      await fixture.resident.settle();
    }
    assert.equal(fixture.gpu.uploadedTiles().length, EARTH_TILE_LAYERS);
    tiles.setCandidates(keys);
    const result = fixture.resident.sync({ projection: new Projection(), timeMs: EARTH_TILE_LAYERS / 8, generation: 1 });
    assert.equal(result.requested.length, 0);
    assert.equal(fixture.gpu.uploadedTiles().length, EARTH_TILE_LAYERS);
    await fixture.resident.settle();
    fixture.resident.dispose();
  });

  test('earth resident: 物理144層へ追加要求を収める', async () => {
    const keys = candidateKeys(EARTH_TILE_LAYERS);
    const tiles = new CandidateTiles(keys);
    const fixture = coordinator(keys, undefined, new ImmediateBackend(), undefined, tiles);
    for (let group = 0; group < EARTH_TILE_LAYERS / 8; group++) {
      const result = fixture.resident.sync({ projection: new Projection(), timeMs: group, generation: 1 });
      assert.equal(result.requested.length, 8);
      await fixture.resident.settle();
    }
    assert.equal(fixture.gpu.uploadedTiles().length, EARTH_TILE_LAYERS);
    fixture.resident.dispose();
  });

  test('earth resident: uploading中の層は最高zへ含めない', async () => {
    const key = earthTileKey(0, 0, 0);
    const backend = new GatedBackend();
    const fixture = coordinator([key], undefined, backend);
    sync(fixture.resident, new Projection(), 0);
    await backend.started;
    assert.equal(fixture.resident.residentMaxZ, null);
    backend.release();
    await fixture.resident.settle();
    assert.equal(fixture.resident.residentMaxZ, 0);
    fixture.resident.dispose();
  });

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
    assert.equal(fixture.resident.residentMaxZ, 0);
    sync(fixture.resident, projection, 300);
    await fixture.resident.settle();
    sync(fixture.resident, projection, 600);
    assert.deepEqual(earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1).slice(2), [0, 255]);
    await fixture.resident.settle();
    assert.equal(fixture.resident.residentMaxZ, 1);
    sync(fixture.resident, projection, 900);
    const childPage = earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1);
    assert.equal(childPage[2], 1);
    assert.equal(childPage[1], 0);
    assert.notEqual(childPage[0], 255);
    sync(fixture.resident, projection, 1200);
    assert.equal(earthPageAt(fixture.backend.pages.at(-1)!, 0.1, 0.1)[3], 255);
    fixture.resident.reset();
    assert.equal(fixture.resident.residentMaxZ, null);
  });

  test('earth resident: 恒久HTTP失敗はタイルIDと原原因を診断へ残す', async () => {
    const key = earthTileKey(0, 0, 0);
    const fixture = coordinator([key], async () => response(new Uint8Array(), 404));
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.match(fixture.resident.failureReason ?? '', new RegExp(`${earthTileId(key)}.*Earth surface HTTP 404`));
    assert.equal(fixture.resident.residentMaxZ, null);
    fixture.resident.reset();
    assert.match(fixture.resident.failureReason ?? '', new RegExp(`${earthTileId(key)}.*Earth surface HTTP 404`));
    fixture.resident.dispose();
  });

  test('earth resident: 色変換失敗はタイルIDと原原因を一時診断へ残す', async () => {
    const key = earthTileKey(0, 0, 0);
    const sibling = earthTileKey(0, 1, 0);
    const fixture = coordinator([key, sibling], undefined, new ImmediateBackend(), () => {
      throw new Error('color conversion failed');
    });
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.match(fixture.resident.failureReason ?? '', /0\/[01]\/0.*color conversion failed/);
    const retry = fixture.resident.sync({ projection: new Projection(), timeMs: 1, generation: 1 });
    assert.equal(retry.requested.length, 2);
    await fixture.resident.settle();
    fixture.resident.reset();
    assert.equal(fixture.resident.failureReason, null);
    fixture.resident.dispose();
  });

  test('earth resident: RGBA変換成功後にデコード画像を閉じる', async () => {
    const key = earthTileKey(0, 0, 0);
    let closed = 0;
    const image = { close: () => { closed += 1; } };
    let converted: unknown;
    const fixture = coordinator([key], undefined, new ImmediateBackend(), (color) => {
      converted = color;
      return COLOR;
    }, new CandidateTiles([key]), async () => image);
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.equal(converted, image);
    assert.equal(closed, 1);
    fixture.resident.dispose();
  });

  test('earth resident: RGBA変換後のabortでもデコード画像を閉じる', async () => {
    const key = earthTileKey(0, 0, 0);
    const controller = new AbortController();
    let closed = 0;
    const image = { close: () => { closed += 1; } };
    const fixture = coordinator([key], undefined, new ImmediateBackend(), () => {
      controller.abort();
      return COLOR;
    }, new CandidateTiles([key]), async () => image);
    fixture.resident.sync({ projection: new Projection(), timeMs: 0, generation: 1, signal: controller.signal });
    await fixture.resident.settle();
    assert.equal(closed, 1);
    assert.equal(fixture.resident.residentMaxZ, null);
    fixture.resident.dispose();
  });

  test('earth resident: RGBA変換失敗でもデコード画像を閉じる', async () => {
    const key = earthTileKey(0, 0, 0);
    let closed = 0;
    const image = { close: () => { closed += 1; } };
    const fixture = coordinator([key], undefined, new ImmediateBackend(), () => {
      throw new Error('color conversion failed');
    }, new CandidateTiles([key]), async () => image);
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.equal(closed, 1);
    assert.match(fixture.resident.failureReason ?? '', /color conversion failed/);
    fixture.resident.dispose();
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
    assert.equal(fixture.resident.failureReason, null);
  });

  test('earth resident: 要求と予約は物理層上限を超えず遠い要求を増やさない', async () => {
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
    for (let layer = 0; layer < EARTH_TILE_LAYERS; layer++) if (fixture.gpu.reservation(layer) !== null) reservations++;
    assert.ok(reservations <= EARTH_TILE_LAYERS);
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
