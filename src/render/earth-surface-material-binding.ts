// 地球表面のGPUテクスチャとNodeMaterialを、既存の球メッシュへ束ねて渡す。
// タイルの選択・公開はcoordinator、球メッシュの材質所有はCelestialSurfaceが担当し、ここは両者の
// 描画用入力を安定したTSLノードへ接続する。
import * as THREE from 'three/webgpu';
import { normalView, positionLocal, uniform } from 'three/tsl';
import type { CelestialSurfaceFrame } from './celestial-surface';
import { DeferredTexture } from './deferred-texture';
import {
  EARTH_BASE_TERRAIN_HEIGHT, EARTH_BASE_TERRAIN_WIDTH, loadEarthBaseTerrain,
} from './earth-surface-decode';
import type { EarthSurfaceGpuTextures } from './earth-surface-gpu';
import { createEarthSurfaceNodeMaterial } from './earth-surface-material-node';
import type { Mat3Uniform, Vec3Node, Vec3Uniform, BoolUniform } from './tsl-types';

export interface EarthSurfaceMaterialBindingOptions {
  readonly baseColorUrl: string;
  readonly baseTerrainUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export interface EarthSurfaceMaterialBinding {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly deferredTextures: readonly DeferredTexture[];
  readonly textures: readonly THREE.Texture[];
  readonly failureReason: () => string | null;
  syncFrame(frame: CelestialSurfaceFrame): void;
  // material/texturesはCelestialSurfaceが所有するため、ここでは非同期処理だけを止める。
  dispose(): void;
}

function defaultTerrainData(): Uint8Array {
  const data = new Uint8Array(EARTH_BASE_TERRAIN_WIDTH * EARTH_BASE_TERRAIN_HEIGHT * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = 128;
    data[offset + 1] = 128;
    data[offset + 2] = 255;
    data[offset + 3] = 255;
  }
  return data;
}

function createBaseTerrainTexture(): { readonly texture: THREE.DataTexture; readonly data: Uint8Array } {
  const data = defaultTerrainData();
  const texture = new THREE.DataTexture(
    data, EARTH_BASE_TERRAIN_WIDTH, EARTH_BASE_TERRAIN_HEIGHT,
    THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, data };
}

// sourceのbaseColor/baseTerrainを共通の材質へ束ねる。baseTerrainの取得に失敗しても、平面法線・粗さ1の
// 初期データを残すため、地表が黒く欠けるのではなくタイルのfallbackへ戻れる。
export function createEarthSurfaceMaterialBinding(
  textures: EarthSurfaceGpuTextures, options: EarthSurfaceMaterialBindingOptions,
): EarthSurfaceMaterialBinding {
  let disposed = false;
  let baseFailureReason: string | null = null;
  const recordBaseFailure = (label: string, error: unknown): void => {
    if (disposed || baseFailureReason !== null) return;
    const detail = error instanceof Error ? error.message : String(error);
    baseFailureReason = `${label}: ${detail}`;
  };
  const baseColor = new DeferredTexture(
    options.baseColorUrl, THREE.SRGBColorSpace,
    (error) => recordBaseFailure('Earth base color unavailable', error),
  );
  const baseTerrain = createBaseTerrainTexture();
  const abortController = new AbortController();
  const axes: Vec3Uniform = uniform(new THREE.Vector3(1, 1, 1));
  const bodyToView: Mat3Uniform = uniform(new THREE.Matrix3());
  const schematic: BoolUniform = uniform(false);
  const bodyDirection = positionLocal.mul(axes) as unknown as Vec3Node;
  let material: THREE.MeshStandardNodeMaterial;
  try {
    material = createEarthSurfaceNodeMaterial(
      { ...textures, baseColor: baseColor.texture, baseTerrain: baseTerrain.texture },
      {
        bodyDirection,
        axes,
        geometricNormalView: normalView as unknown as Vec3Node,
        bodyToView,
        schematic,
      },
    );
  } catch (error) {
    abortController.abort();
    baseColor.dispose();
    baseTerrain.texture.dispose();
    throw error;
  }
  void loadEarthBaseTerrain(options.baseTerrainUrl, options.fetchImpl ?? fetch, abortController.signal)
    .then((data) => {
      if (disposed) return;
      baseTerrain.data.set(data);
      baseTerrain.texture.needsUpdate = true;
    })
    .catch((error: unknown) => recordBaseFailure('Earth base terrain unavailable', error));

  return {
    material,
    deferredTextures: [baseColor],
    textures: [baseTerrain.texture],
    failureReason: () => baseFailureReason,
    syncFrame: (frame) => {
      if (disposed) return;
      axes.value.copy(frame.axes);
      bodyToView.value.setFromMatrix4(frame.bodyToView);
      schematic.value = frame.style === 'schematic';
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      abortController.abort();
    },
  };
}
