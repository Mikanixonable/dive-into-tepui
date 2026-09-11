// 地球表面のGPUテクスチャとNodeMaterialを、既存の球メッシュへ束ねて渡す。
// タイルの選択・公開はcoordinator、球メッシュの材質所有はCelestialSurfaceが担当し、ここは両者の
// 描画用入力を安定したTSLノードへ接続する。
import * as THREE from 'three/webgpu';
import { normalView, positionLocal, uniform } from 'three/tsl';
import type { CelestialSurfaceFrame } from './celestial/celestial-surface';
import { DeferredTexture } from './deferred-texture';
import {
  EARTH_BASE_TERRAIN_HEIGHT, EARTH_BASE_TERRAIN_WIDTH, loadEarthBaseTerrain,
} from './earth-surface-decode';
import type { EarthSurfaceGpuTextures } from './earth-surface-gpu';
import { createEarthSurfaceNodeMaterial } from './earth-surface-material-node';
import type { Mat3Uniform, Vec3Node, Vec3Uniform, BoolUniform } from './tsl-types';

export interface EarthSurfaceMaterialBinding {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly deferredTextures: readonly DeferredTexture[];
  readonly textures: readonly THREE.Texture[];
  readonly failureReason: () => string | null;
  syncFrame(frame: CelestialSurfaceFrame): void;
  // material/texturesはCelestialSurfaceが所有するため、ここでは非同期処理だけを止める。
  dispose(): void;
}

const FLOAT16_ONE = 0x3c00;

function defaultTerrainData(): Uint16Array {
  const data = new Uint16Array(EARTH_BASE_TERRAIN_WIDTH * EARTH_BASE_TERRAIN_HEIGHT * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset + 1] = FLOAT16_ONE;
    data[offset + 3] = FLOAT16_ONE;
  }
  return data;
}

function createBaseTerrainTexture(): { readonly texture: THREE.DataTexture; readonly data: Uint16Array } {
  const data = defaultTerrainData();
  const texture = new THREE.DataTexture(
    data, EARTH_BASE_TERRAIN_WIDTH, EARTH_BASE_TERRAIN_HEIGHT,
    THREE.RGBAFormat, THREE.HalfFloatType,
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

// baseColorUrl/baseTerrainUrlの画像を共通の材質へ束ねる。fetchImplはbaseTerrainの取得に使い、省けば
// fetch。baseTerrainの取得に失敗しても、平面法線・粗さ1の初期データを残すため、地表が黒く欠けるの
// ではなくタイルのfallbackへ戻れる。
export function createEarthSurfaceMaterialBinding(
  textures: EarthSurfaceGpuTextures, baseColorUrl: string, baseTerrainUrl: string, fetchImpl?: typeof fetch,
): EarthSurfaceMaterialBinding {
  // base画像の取得失敗は、最初の1件だけを理由として残す。
  let disposed = false;
  let baseFailureReason: string | null = null;
  const recordBaseFailure = (label: string, error: unknown): void => {
    if (disposed || baseFailureReason !== null) return;
    const detail = error instanceof Error ? error.message : String(error);
    baseFailureReason = `${label}: ${detail}`;
  };
  // base画像のテクスチャと、フレームごとに書き換える天体の形・姿勢のuniform。
  const baseColor = new DeferredTexture(
    baseColorUrl, THREE.SRGBColorSpace,
    (error) => recordBaseFailure('Earth base color unavailable', error),
  );
  const baseTerrain = createBaseTerrainTexture();
  const abortController = new AbortController();
  const axes: Vec3Uniform = uniform(new THREE.Vector3(1, 1, 1));
  const bodyToView: Mat3Uniform = uniform(new THREE.Matrix3());
  const schematic: BoolUniform = uniform(false);
  const bodyDirection = positionLocal.mul(axes) as unknown as Vec3Node;
  // 材質を組めなければ、先に確保した取得とテクスチャを解放してから投げ直す。
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
  // baseTerrainは届いた時点で初期データへ上書きする。
  void loadEarthBaseTerrain(baseTerrainUrl, fetchImpl ?? fetch, abortController.signal)
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
