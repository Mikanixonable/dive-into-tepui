// 要求の到着順、親fallback、同時upload、破棄境界、配列層上限を検査する。
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from '../harness';
import { EarthSurfaceResidentCoordinator } from '../../src/render/earth-surface-resident';
import { EarthSurfaceGpuAdapter } from '../../src/render/earth-surface-gpu';
import type { EarthSurfaceColorToRgba8 } from '../../src/render/earth-surface-resident';
import type { EarthSurfaceGpuBackend, EarthSurfaceGpuCapabilities } from '../../src/render/earth-surface-gpu';
import { EarthSurfaceTileRequestQueue } from '../../src/render/earth-surface-tile-queue';
import { EarthSurfaceTileSource } from '../../src/render/earth-surface-tile-source';
import { EARTH_TERRAIN_BYTES, EARTH_TERRAIN_HEADER_BYTES } from '../../src/render/earth-surface-format';
import {
  EARTH_TILE_EXTENT, EARTH_TILE_LAYERS, EARTH_TILE_MIN_Z,
  earthTileChildren, earthTileId, earthTileKey, earthTileParent,
} from '../../src/render/earth-surface-tile-key';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH, earthPageAt } from '../../src/render/earth-surface-page-table';
import { EarthSurfaceTiles } from '../../src/render/earth-surface-tiles';
import type { EarthTileResident } from '../../src/render/earth-surface-tiles';
import type { EarthTileKey } from '../../src/render/earth-surface-tile-key';
import type { EarthTileProjection } from '../../src/render/earth-surface-tile-projection';

const CAPABILITIES: EarthSurfaceGpuCapabilities = {
  texture2dArray: true, maxTextureArrayLayers: EARTH_TILE_LAYERS, colorSrgbLinear: true, terrainRgba8Linear: true,
};
const PIXELS = EARTH_TILE_EXTENT * EARTH_TILE_EXTENT * 4;
const COLOR = new Uint8Array(PIXELS).fill(17);

class ImmediateBackend implements EarthSurfaceGpuBackend {
  public readonly pages: Uint8Array[] = [];
  public readonly writes: number[] = [];
  public disposed = false;
  public constructor(public readonly capabilities = CAPABILITIES) {}
  public writeColor(layer: number, _pixels: Uint8Array): Promise<void> { this.writes.push(layer); return Promise.resolve(); }
  public writeTerrain(_layer: number, _pixels: Uint8Array): Promise<void> { return Promise.resolve(); }
  public swapPageTable(pixels: Uint8Array): void { this.pages.push(pixels.slice()); }
  public dispose(): void { this.disposed = true; }
}

function terrain(key: EarthTileKey): Uint8Array {
  const bytes = new Uint8Array(EARTH_TERRAIN_HEADER_BYTES + EARTH_TERRAIN_BYTES);
  bytes.set(new TextEncoder().encode('ESTN'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 3, true); view.setUint16(6, 32, true);
  view.setUint16(8, 260, true); view.setUint16(10, 260, true);
  view.setUint8(12, key.z); view.setUint32(14, key.x, true); view.setUint32(18, key.y, true);
  view.setUint8(22, 4); view.setUint8(23, 2); view.setUint32(24, EARTH_TERRAIN_BYTES, true);
  return bytes;
}

class Projection implements EarthTileProjection {
  public constructor(public readonly splitError = 3, public readonly maximumLevel = EARTH_TILE_MIN_Z) {}
  public evaluate(key: EarthTileKey): { readonly visible: boolean; readonly errorPx: number; readonly priority: number } {
    return { visible: true, errorPx: key.z <= this.maximumLevel ? this.splitError : 0, priority: 1 / (1 + key.z) };
  }
}

class CountingProjection extends Projection {
  public evaluations = 0;

  public override evaluate(key: EarthTileKey): { readonly visible: boolean; readonly errorPx: number; readonly priority: number } {
    this.evaluations++;
    return super.evaluate(key);
  }
}

class CandidateTiles extends EarthSurfaceTiles {
  public constructor(private candidates: readonly EarthTileKey[]) { super(); }

  public setCandidates(candidates: readonly EarthTileKey[]): void { this.candidates = candidates; }

  // admissionだけを検査するテスト用に、投影やfrontierとは独立した候補列を返す。
  public override requestCandidates(_projection: EarthTileProjection): readonly EarthTileKey[] {
    return this.candidates;
  }

  public override prefetchCandidates(_projection: EarthTileProjection): readonly EarthTileKey[] { return []; }

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
  const source = new EarthSurfaceTileSource('{z}/{x}/{y}.jpg', '{z}/{x}/{y}.bin.gz');
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
  public async writeTerrain(layer: number, pixels: Uint8Array): Promise<void> {
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

  public async writeTerrain(layer: number, pixels: Uint8Array): Promise<void> {
    if (layer === 0) await this.firstGate;
    await super.writeTerrain(layer, pixels);
    if (layer === 1) this.markSecondWrite();
  }
}

function sync(resident: EarthSurfaceResidentCoordinator, projection: EarthTileProjection, timeMs: number, generation = 1): void {
  resident.sync({ projection, timeMs, generation });
}

export function register(): void {
  test('earth resident: 静止安定後は投影評価とページ表公開を繰り返さない', async () => {
    const keys = [earthTileKey(EARTH_TILE_MIN_Z, 0, 0), earthTileKey(EARTH_TILE_MIN_Z, 1, 0)];
    const fixture = coordinator(keys, undefined, new ImmediateBackend(), undefined, new CandidateTiles(keys));
    const projection = new CountingProjection(0, -1);
    fixture.resident.sync({ projection, timeMs: 0, generation: 1 });
    await fixture.resident.settle();
    fixture.resident.sync({ projection, timeMs: 1, generation: 1 });
    await fixture.resident.settle();
    fixture.resident.sync({ projection, timeMs: 252, generation: 1 });
    const evaluations = projection.evaluations;
    const pages = fixture.backend.pages.length;
    await fixture.resident.settle();

    const result = fixture.resident.sync({ projection, timeMs: 1000, generation: 1 });
    assert.equal(result.published, false);
    assert.deepEqual(result.requested, []);
    assert.equal(projection.evaluations, evaluations);
    assert.equal(fixture.backend.pages.length, pages);
    fixture.resident.dispose();
  });

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

  test('earth resident: 物理96層へ追加要求を収める', async () => {
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
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
    const backend = new GatedBackend();
    const fixture = coordinator([key], undefined, backend);
    sync(fixture.resident, new Projection(), 0);
    await backend.started;
    assert.equal(fixture.resident.residentMaxZ, null);
    backend.release();
    await fixture.resident.settle();
    assert.equal(fixture.resident.residentMaxZ, EARTH_TILE_MIN_Z);
    fixture.resident.dispose();
  });

  test('earth resident: 同一世代の視点変更で旧pendingをcancelし新しい可視要求を優先する', async () => {
    const oldKey = earthTileKey(7, 0, 0);
    const newKey = earthTileKey(7, 1, 0);
    let oldStarted!: () => void;
    const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
    let oldAborted = false;
    const tiles = new CandidateTiles([oldKey]);
    const fixture = coordinator([oldKey, newKey], async (input, init) => {
      const url = String(input);
      const id = url.replace(/\.(jpg|bin\.gz)$/, '');
      if (id === earthTileId(oldKey)) {
        oldStarted();
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            oldAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      const key = id === earthTileId(newKey) ? newKey : oldKey;
      return String(input).endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    }, undefined, undefined, tiles);
    sync(fixture.resident, new Projection(), 0);
    await oldStartedPromise;
    tiles.setCandidates([newKey]);
    const result = fixture.resident.sync({ projection: new Projection(), timeMs: 1, generation: 1 });
    assert.deepEqual(result.requested.map(earthTileId), [earthTileId(newKey)]);
    assert.equal(oldAborted, true);
    await fixture.resident.settle();
    assert.equal(fixture.resident.residentMaxZ, 7);
    fixture.resident.dispose();
  });

  test('earth resident: cancelPendingはresidentとGPU層を保持する', async () => {
    const key = earthTileKey(7, 0, 0);
    const fixture = coordinator([key], undefined, new ImmediateBackend(), undefined, new CandidateTiles([key]));
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.equal(fixture.resident.residentMaxZ, 7);
    const uploaded = fixture.gpu.uploadedTiles().length;
    fixture.resident.cancelPending();
    assert.equal(fixture.gpu.uploadedTiles().length, uploaded);
    assert.equal(fixture.resident.residentMaxZ, 7);
    fixture.resident.dispose();
  });

  test('earth resident: 恒久HTTP失敗はタイルIDと原原因を診断へ残す', async () => {
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
    const fixture = coordinator([key], async () => response(new Uint8Array(), 404), undefined, undefined, new CandidateTiles([key]));
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.match(fixture.resident.failureReason ?? '', new RegExp(`${earthTileId(key)}.*Earth surface HTTP 404`));
    assert.equal(fixture.resident.residentMaxZ, null);
    fixture.resident.reset();
    assert.match(fixture.resident.failureReason ?? '', new RegExp(`${earthTileId(key)}.*Earth surface HTTP 404`));
    fixture.resident.dispose();
  });

  test('earth resident: 色変換失敗はタイルIDと原原因を一時診断へ残す', async () => {
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
    const sibling = earthTileKey(EARTH_TILE_MIN_Z, 1, 0);
    const fixture = coordinator([key, sibling], undefined, new ImmediateBackend(), () => {
      throw new Error('color conversion failed');
    }, new CandidateTiles([key, sibling]));
    sync(fixture.resident, new Projection(), 0);
    await fixture.resident.settle();
    assert.match(fixture.resident.failureReason ?? '', /5\/[01]\/0.*color conversion failed/);
    const retry = fixture.resident.sync({ projection: new Projection(), timeMs: 1, generation: 1 });
    assert.equal(retry.requested.length, 2);
    await fixture.resident.settle();
    fixture.resident.reset();
    assert.equal(fixture.resident.failureReason, null);
    fixture.resident.dispose();
  });

  test('earth resident: RGBA変換成功後にデコード画像を閉じる', async () => {
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
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
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
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
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
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

  test('earth resident: 個別タイルの片側失敗は親fallbackを残し他の子を公開する', async () => {
    const roots = [earthTileKey(EARTH_TILE_MIN_Z, 0, 0), earthTileKey(EARTH_TILE_MIN_Z, 1, 0)];
    const children = earthTileChildren(roots[0]!);
    const failed = children[3]!;
    const fixture = coordinator([...roots, ...children], async (input) => {
      if (String(input).includes(`${failed.z}/${failed.x}/${failed.y}`) && String(input).endsWith('.jpg')) return response(new Uint8Array(), 404);
      const id = String(input).replace(/\.(jpg|bin\.gz)$/, '');
      const key = [...roots, ...children].find((candidate) => earthTileId(candidate) === id);
      if (key === undefined) throw new Error(`missing fixture ${id}`);
      return String(input).endsWith('.jpg') ? response(COLOR) : response(gzipSync(terrain(key)));
    });
    const selectionRoots = roots.map(earthTileParent).filter((key) => key !== null);
    const visible = new Set([...selectionRoots, ...roots, ...children].map(earthTileId));
    const projection: EarthTileProjection = {
      evaluate: (key) => ({
        visible: visible.has(earthTileId(key)),
        errorPx: key.z === EARTH_TILE_MIN_Z ? 3 : 1,
        priority: 1,
      }),
    };
    sync(fixture.resident, projection, 0);
    await fixture.resident.settle();
    sync(fixture.resident, projection, 300);
    const good = children[0]!;
    const goodPage = earthPageAt(fixture.backend.pages.at(-1)!, (good.x + 0.5) / 2 ** (good.z + 1), (good.y + 0.5) / 2 ** good.z);
    assert.equal(goodPage[2], good.z);
    const failedPage = earthPageAt(fixture.backend.pages.at(-1)!, (failed.x + 0.5) / 2 ** (failed.z + 1), (failed.y + 0.5) / 2 ** failed.z);
    assert.equal(failedPage[2], EARTH_TILE_MIN_Z);
  });

  test('earth resident: disposeは遅着を公開せずqueueとGPUを破棄する', async () => {
    const key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0);
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
    assert.deepEqual(earthPageAt(fixture.backend.pages[1]!, 0.01, 0.01), [255, 255, 255, 255]);
    assert.equal(fixture.backend.disposed, true);
    assert.equal(fixture.gpu.uploadedTiles().length, 0);
    assert.equal(fixture.resident.failureReason, null);
  });

  test('earth resident: 要求と予約は物理層上限を超えず遠い要求を増やさない', async () => {
    const keys: EarthTileKey[] = [];
    for (let z = EARTH_TILE_MIN_Z; z <= EARTH_TILE_MIN_Z; z++) {
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
    const fixture = coordinator([earthTileKey(EARTH_TILE_MIN_Z, 0, 0)]);
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
