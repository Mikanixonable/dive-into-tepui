// Three.jsのDataArrayTextureへ地球タイルを書き込むGPU境界。
// タイル選択・世代・公開順はEarthSurfaceGpuAdapterが所有し、このクラスは実テクスチャの
// 生成と非公開層へのバッファ書込みだけを担当する。WebGPU非対応時は配列層を作らずbaseへ固定する。
import * as THREE from 'three/webgpu';
import { EARTH_PAGE_HEIGHT, EARTH_PAGE_WIDTH } from './earth-surface-page-table';
import { EARTH_TILE_EXTENT, EARTH_TILE_LAYERS } from './earth-surface-tile-key';
import {
  supportsEarthSurfaceTiles,
  type EarthSurfaceGpuBackend,
  type EarthSurfaceGpuCapabilities,
  type EarthSurfaceGpuTextures,
} from './earth-surface-gpu';
import { configureEarthSurfaceTexture } from './earth-surface-texture';

const EARTH_CHANNELS = 4;
const EARTH_TILE_COMPONENTS = EARTH_TILE_EXTENT * EARTH_TILE_EXTENT * EARTH_CHANNELS;

export interface EarthSurfaceGpuThreeBackendLike {
  readonly isWebGPUBackend?: boolean;
  readonly device?: {
    readonly limits?: { readonly maxTextureArrayLayers?: number };
  };
}

// Renderer.backendの公開情報だけを使い、判定できない機能は未対応として扱う。
export function earthSurfaceGpuCapabilitiesOf(
  backend: EarthSurfaceGpuThreeBackendLike,
): EarthSurfaceGpuCapabilities {
  const webgpu = backend.isWebGPUBackend === true;
  const maxTextureArrayLayers = backend.device?.limits?.maxTextureArrayLayers ?? 0;
  return {
    texture2dArray: webgpu,
    maxTextureArrayLayers,
    // WebGPUのRGBA8 sRGBとRGBA8線形値はDataArrayTextureの標準形式として扱う。
    colorSrgbLinear: webgpu,
    terrainRgba8Linear: webgpu,
  };
}

function requireLayer(layer: number): void {
  if (!Number.isInteger(layer) || layer < 0 || layer >= EARTH_TILE_LAYERS) {
    throw new RangeError('Invalid Earth texture layer');
  }
}

function requirePixels(pixels: Uint8Array, expected: number, label: string): void {
  if (pixels.length !== expected) throw new RangeError(`Invalid Earth ${label} size`);
}

export class EarthSurfaceGpuThree implements EarthSurfaceGpuBackend {
  public readonly textures: EarthSurfaceGpuTextures | null;
  private disposed = false;

  public constructor(public readonly capabilities: EarthSurfaceGpuCapabilities) {
    if (!supportsEarthSurfaceTiles(capabilities)) {
      this.textures = null;
      return;
    }
    const color = configureEarthSurfaceTexture(
      new THREE.DataArrayTexture(
        new Uint8Array(EARTH_TILE_COMPONENTS * EARTH_TILE_LAYERS),
        EARTH_TILE_EXTENT, EARTH_TILE_EXTENT, EARTH_TILE_LAYERS,
      ), 'color',
    );
    const terrain = configureEarthSurfaceTexture(
      new THREE.DataArrayTexture(
        new Uint8Array(EARTH_TILE_COMPONENTS * EARTH_TILE_LAYERS),
        EARTH_TILE_EXTENT, EARTH_TILE_EXTENT, EARTH_TILE_LAYERS,
      ), 'terrain',
    );
    const pageTable = configureEarthSurfaceTexture(new THREE.DataTexture(
      new Uint8Array(EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * EARTH_CHANNELS),
      EARTH_PAGE_WIDTH, EARTH_PAGE_HEIGHT, THREE.RGBAFormat, THREE.UnsignedByteType,
    ), 'pageTable');
    this.textures = { color, terrain, pageTable };
  }

  public writeColor(layer: number, pixels: Uint8Array): Promise<void> {
    const textures = this.requireTextures();
    requireLayer(layer);
    requirePixels(pixels, EARTH_TILE_COMPONENTS, 'color tile');
    const data = textures.color.image.data;
    if (!(data instanceof Uint8Array)) throw new Error('Earth color texture has an unexpected format');
    data.set(pixels, layer * EARTH_TILE_COMPONENTS);
    textures.color.addLayerUpdate(layer);
    textures.color.needsUpdate = true;
    return Promise.resolve();
  }

  public writeTerrain(layer: number, pixels: Uint8Array): Promise<void> {
    const textures = this.requireTextures();
    requireLayer(layer);
    requirePixels(pixels, EARTH_TILE_COMPONENTS, 'terrain tile');
    const data = textures.terrain.image.data;
    if (!(data instanceof Uint8Array)) throw new Error('Earth terrain texture has an unexpected format');
    data.set(pixels, layer * EARTH_TILE_COMPONENTS);
    textures.terrain.addLayerUpdate(layer);
    textures.terrain.needsUpdate = true;
    return Promise.resolve();
  }

  public swapPageTable(pixels: Uint8Array): void {
    const textures = this.requireTextures();
    const expected = EARTH_PAGE_WIDTH * EARTH_PAGE_HEIGHT * EARTH_CHANNELS;
    requirePixels(pixels, expected, 'page table');
    const data = textures.pageTable.image.data;
    if (!(data instanceof Uint8Array)) throw new Error('Earth page table has an unexpected format');
    data.set(pixels);
    textures.pageTable.needsUpdate = true;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.textures?.color.dispose();
    this.textures?.terrain.dispose();
    this.textures?.pageTable.dispose();
  }

  private requireTextures(): EarthSurfaceGpuTextures {
    if (this.disposed) throw new Error('Earth GPU backend is disposed');
    if (this.textures === null) throw new Error('Earth surface uses the global base');
    return this.textures;
  }
}

// 実Rendererへ接続するときの薄い生成入口。WebGPU以外ではbase-onlyの器を返す。
export function createEarthSurfaceGpuThree(
  backend: EarthSurfaceGpuThreeBackendLike,
): EarthSurfaceGpuThree {
  return new EarthSurfaceGpuThree(earthSurfaceGpuCapabilitiesOf(backend));
}
