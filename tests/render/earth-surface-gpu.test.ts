// GPU公開の原子性、層の使用権と遅着の世代境界を代替backendで検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { EarthSurfaceGpuAdapter } from '../../src/render/earth-surface-gpu';
import { EarthSurfaceGpuThree, earthSurfaceGpuCapabilitiesOf } from '../../src/render/earth-surface-gpu-three';
import {
  EARTH_TILE_EXTENT, EARTH_TILE_LAYERS, EARTH_TILE_MIN_Z, earthTileKey,
} from '../../src/render/earth-surface-tile-key';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from '../../src/render/earth-surface-page-table';
import type { EarthSurfaceGpuBackend, EarthSurfaceGpuCapabilities } from '../../src/render/earth-surface-gpu';

const SUPPORTED: EarthSurfaceGpuCapabilities = {
  texture2dArray: true, maxTextureArrayLayers: EARTH_TILE_LAYERS, colorSrgbLinear: true, terrainRgba8Linear: true,
};
const COMPONENTS = EARTH_TILE_EXTENT * EARTH_TILE_EXTENT * 4;

class PendingWrite {
  private complete: (() => void) | null = null;
  private fail: ((reason: Error) => void) | null = null;
  public readonly promise = new Promise<void>((resolve, reject) => { this.complete = resolve; this.fail = reject; });

  // この書込みの完了を通知する。
  public resolve(): void { this.complete?.(); }

  // この書込みの失敗を通知する。
  public reject(): void { this.fail?.(new Error('Synthetic upload failure')); }
}

class FakeBackend implements EarthSurfaceGpuBackend {
  public readonly color = new PendingWrite();
  public readonly terrain = new PendingWrite();
  public readonly pages: Uint8Array[] = [];
  public readonly writes: string[] = [];
  public disposals = 0;

  // 機能の欠けたbackendも同じ操作境界で表す。
  public constructor(public readonly capabilities = SUPPORTED) {}

  // 色だけの完了順を制御する。
  public writeColor(layer: number, _pixels: Uint8Array): Promise<void> {
    this.writes.push(`color:${layer}`);
    return this.color.promise;
  }

  // 地形だけの完了順を制御する。
  public writeTerrain(layer: number, _pixels: Uint8Array): Promise<void> {
    this.writes.push(`terrain:${layer}`);
    return this.terrain.promise;
  }

  // 公開したフレームの内容を検査用に保持する。
  public swapPageTable(pixels: Uint8Array): void { this.pages.push(pixels.slice()); }

  // 資源解放回数を記録する。
  public dispose(): void { this.disposals++; }
}

// 指定したz4以上のタイルを1層へ写すページ表。引数省略時は全球ベース。
function page(layer = 255, key = earthTileKey(EARTH_TILE_MIN_Z, 0, 0)): Uint8Array {
  const table = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(255);
  if (layer === 255) return table;
  const size = 2 ** (7 - key.z);
  for (let y = key.y * size; y < (key.y + 1) * size; y++) {
    for (let x = key.x * size; x < (key.x + 1) * size; x++) {
      table.set([layer, 255, key.z, 255], (y * EARTH_PAGE_WIDTH + x) * 4);
    }
  }
  return table;
}

// この層の回帰テストを登録する。
export function register(): void {
  test('earth GPU: Three実装は対応時だけ配列層を作り、層更新を実テクスチャへ反映する', async () => {
    assert.equal(SUPPORTED.maxTextureArrayLayers, 96);
    const backend = new EarthSurfaceGpuThree(SUPPORTED);
    const textures = backend.textures;
    assert.ok(textures !== null);
    assert.equal(textures.color.image.depth, EARTH_TILE_LAYERS);
    assert.equal(textures.color.colorSpace, THREE.SRGBColorSpace);
    assert.equal(textures.color.minFilter, THREE.LinearFilter);
    assert.equal(textures.terrain.type, THREE.UnsignedByteType);
    assert.equal(textures.pageTable.minFilter, THREE.NearestFilter);
    await backend.writeColor(3, new Uint8Array(COMPONENTS).fill(7));
    await backend.writeTerrain(3, new Uint8Array(COMPONENTS).fill(11));
    assert.equal(textures.color.image.data![3 * COMPONENTS], 7);
    assert.equal(textures.terrain.image.data![3 * COMPONENTS], 11);
    const pages = new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * 4).fill(255);
    backend.swapPageTable(pages);
    assert.equal(textures.pageTable.image.data![0], 255);
    backend.dispose();
    assert.throws(() => backend.swapPageTable(pages), /disposed/);
  });

  test('earth GPU: Three実装はWebGPU機能不足時にbase-onlyへ固定する', () => {
    const backend = new EarthSurfaceGpuThree({ ...SUPPORTED, texture2dArray: false });
    assert.equal(backend.textures, null);
    assert.throws(() => backend.writeColor(0, new Uint8Array(COMPONENTS)), /global base/);
    assert.deepEqual(earthSurfaceGpuCapabilitiesOf({ isWebGPUBackend: false }), {
      texture2dArray: false, maxTextureArrayLayers: 0, colorSrgbLinear: false, terrainRgba8Linear: false,
    });
  });

  test('earth GPU: 配列層や線形標本化が不足すればbaseへ固定する', () => {
    for (const capabilities of [
      { ...SUPPORTED, texture2dArray: false }, { ...SUPPORTED, maxTextureArrayLayers: EARTH_TILE_LAYERS - 1 },
      { ...SUPPORTED, colorSrgbLinear: false }, { ...SUPPORTED, terrainRgba8Linear: false },
    ]) {
      const backend = new FakeBackend(capabilities);
      const adapter = new EarthSurfaceGpuAdapter(backend);
      assert.equal(adapter.mode, 'base');
      assert.throws(() => adapter.reserveLayer(earthTileKey(EARTH_TILE_MIN_Z, 0, 0), 0));
      assert.equal(adapter.publishFrame(0), false);
      assert.equal(backend.writes.length, 0);
    }
  });

  test('earth GPU: 色と地形がそろった層をフレーム境界で同時に公開する', async () => {
    const backend = new FakeBackend();
    const adapter = new EarthSurfaceGpuAdapter(backend);
    adapter.reserveLayer(earthTileKey(EARTH_TILE_MIN_Z, 0, 0), 0);
    const reservation = adapter.reservation(0)!;
    const upload = adapter.uploadLayer(new Uint8Array(COMPONENTS), new Uint8Array(COMPONENTS), reservation);
    backend.color.resolve();
    await Promise.resolve();
    assert.equal(adapter.uploadedTiles().length, 0);
    assert.throws(() => adapter.stagePageTable(page(0)), /incomplete/);
    assert.throws(() => adapter.releaseLayer(reservation), /in use/);
    backend.terrain.resolve();
    await upload;
    assert.equal(adapter.uploadedTiles().length, 1);

    // 公開予約後の入力配列の変更は、次のフレームへ混入しない。
    const table = page(0);
    adapter.stagePageTable(table);
    table.fill(255);
    assert.equal(backend.pages.length, 0);
    assert.equal(adapter.publishFrame(10), true);
    assert.equal(backend.pages[0]![0], 0);
    assert.throws(() => adapter.releaseLayer(reservation), /in use/);
    await assert.rejects(adapter.uploadLayer(new Uint8Array(COMPONENTS), new Uint8Array(COMPONENTS), reservation), /writable/);
    adapter.stagePageTable(page());
    assert.equal(adapter.publishFrame(10), false);
    assert.equal(adapter.publishFrame(11), true);
    adapter.releaseLayer(reservation);

    // 同じ層番号を予約し直しても、前の世代が書き込む権利は復活しない。
    adapter.reserveLayer(earthTileKey(EARTH_TILE_MIN_Z, 1, 0), 0);
    assert.ok(adapter.reservation(0)!.generation > reservation.generation);
    await assert.rejects(adapter.uploadLayer(new Uint8Array(COMPONENTS), new Uint8Array(COMPONENTS), reservation), /Stale/);
  });

  test('earth GPU: z5以降のページセルも対応するタイル層へ限定する', async () => {
    const backend = new FakeBackend();
    const adapter = new EarthSurfaceGpuAdapter(backend);
    const parent = earthTileKey(EARTH_TILE_MIN_Z, 1, 0);
    const child = earthTileKey(EARTH_TILE_MIN_Z + 1, 2, 1);
    adapter.reserveLayer(parent, 0);
    adapter.reserveLayer(child, 1);
    const parentReservation = adapter.reservation(0)!;
    const childReservation = adapter.reservation(1)!;
    const bytes = new Uint8Array(COMPONENTS);
    const terrain = new Uint8Array(COMPONENTS);
    const parentUpload = adapter.uploadLayer(bytes, terrain, parentReservation);
    const childUpload = adapter.uploadLayer(bytes, terrain, childReservation);
    backend.color.resolve();
    backend.terrain.resolve();
    await Promise.all([parentUpload, childUpload]);
    const table = page(0, parent);
    const size = 2 ** (7 - child.z);
    for (let y = child.y * size; y < (child.y + 1) * size; y++) {
      for (let x = child.x * size; x < (child.x + 1) * size; x++) {
        table.set([1, 0, child.z, 255], (y * EARTH_PAGE_WIDTH + x) * 4);
      }
    }
    adapter.stagePageTable(table);
    assert.equal(adapter.publishFrame(1), true);
  });

  test('earth GPU: 一方が失敗しても残る書込みが終わるまで再利用できない', async () => {
    const backend = new FakeBackend();
    const adapter = new EarthSurfaceGpuAdapter(backend);
    adapter.reserveLayer(earthTileKey(EARTH_TILE_MIN_Z, 0, 0), 0);
    const reservation = adapter.reservation(0)!;
    const upload = adapter.uploadLayer(new Uint8Array(COMPONENTS), new Uint8Array(COMPONENTS), reservation);
    const rejected = assert.rejects(upload, /Synthetic/);
    backend.color.reject();
    await Promise.resolve();
    assert.throws(() => adapter.releaseLayer(reservation), /in use/);
    backend.terrain.resolve();
    await rejected;
    assert.throws(() => adapter.stagePageTable(page(0)), /incomplete/);
    adapter.releaseLayer(reservation);
  });

  test('earth GPU: dispose後に完了しても層やページ表を公開しない', async () => {
    const backend = new FakeBackend();
    const adapter = new EarthSurfaceGpuAdapter(backend);
    adapter.reserveLayer(earthTileKey(EARTH_TILE_MIN_Z, 0, 0), 0);
    const upload = adapter.uploadLayer(new Uint8Array(COMPONENTS), new Uint8Array(COMPONENTS), adapter.reservation(0)!);
    adapter.dispose();
    backend.terrain.resolve();
    backend.color.resolve();
    await upload;
    assert.deepEqual(adapter.uploadedTiles(), []);
    assert.equal(adapter.publishFrame(1), false);
    assert.equal(backend.pages.length, 0);
    assert.equal(backend.disposals, 1);
    adapter.dispose();
    assert.equal(backend.disposals, 1);
  });
}
