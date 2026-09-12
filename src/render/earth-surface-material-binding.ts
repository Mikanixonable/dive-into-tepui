// 地球表面の材質を組む。タイルの GPU テクスチャと base 画像を1枚の NodeMaterial へ束ね、
// 天体の形・姿勢と見せ方をフレームごとに渡す。
import * as THREE from 'three/webgpu';
import { normalView, positionLocal, uniform } from 'three/tsl';
import type { CelestialSurfaceFrame } from './celestial/celestial-surface';
import { DeferredTexture } from './deferred-texture';
import {
  EARTH_BASE_TERRAIN_HEIGHT, EARTH_BASE_TERRAIN_WIDTH, loadEarthBaseTerrain,
} from './earth-surface-terrain-codec';
import type { EarthSurfaceGpuTextures } from './earth-surface-gpu';
import { createEarthSurfaceNodeMaterial } from './earth-surface-material-node';
import { configureEarthSurfaceTexture } from './earth-surface-texture';
import type { Mat3Uniform, Vec3Node, Vec3Uniform, BoolUniform } from './tsl-types';

export interface EarthSurfaceMaterialBinding {
  readonly material: THREE.MeshStandardNodeMaterial;
  readonly deferredTextures: readonly DeferredTexture[];
  readonly textures: readonly THREE.Texture[];
  // base 画像の取得に失敗した最初の理由。失敗していなければ null。
  readonly failureReason: () => string | null;
  readonly ready: () => boolean;
  prepare(): void;
  syncFrame(frame: CelestialSurfaceFrame): void;
  // base 画像の取得を止める。material・deferredTextures・textures の解放は受け取った側が行う。
  dispose(): void;
}

function defaultTerrainData(): Uint8Array {
  const data = new Uint8Array(EARTH_BASE_TERRAIN_WIDTH * EARTH_BASE_TERRAIN_HEIGHT * 4);
  for (let y = 0; y < EARTH_BASE_TERRAIN_HEIGHT; y++) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / EARTH_BASE_TERRAIN_HEIGHT);
    const horizontal = Math.cos(latitude);
    for (let x = 0; x < EARTH_BASE_TERRAIN_WIDTH; x++) {
      const longitude = 2 * Math.PI * ((x + 0.5) / EARTH_BASE_TERRAIN_WIDTH - 0.5);
      const offset = (y * EARTH_BASE_TERRAIN_WIDTH + x) * 4;
      data[offset] = Math.round((Math.sin(longitude) * horizontal * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((Math.sin(latitude) * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((Math.cos(longitude) * horizontal * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  return data;
}

function createBaseTerrainTexture(): { readonly texture: THREE.DataTexture; readonly data: Uint8Array } {
  const data = defaultTerrainData();
  const texture = new THREE.DataTexture(
    data, EARTH_BASE_TERRAIN_WIDTH, EARTH_BASE_TERRAIN_HEIGHT,
    THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  configureEarthSurfaceTexture(texture, 'terrain');
  texture.needsUpdate = true;
  return { texture, data };
}

// タイルとbase画像を束ねた材質を組む。sharedBaseColorを渡すと既存の全球画像を借り、所有しない。
// baseTerrainが届くまでは、同じ地理座標の楕円体法線と粗さ1で描く。
export function createEarthSurfaceMaterialBinding(
  textures: EarthSurfaceGpuTextures, baseColorUrl: string, baseTerrainUrl: string, fetchImpl?: typeof fetch,
  sharedBaseColor?: THREE.Texture,
): EarthSurfaceMaterialBinding {
  let disposed = false;
  let baseFailureReason: string | null = null;
  // base 画像の取得失敗を記録する。理由として残すのは最初の1件で、dispose 後は記録しない。
  const recordBaseFailure = (label: string, error: unknown): void => {
    if (disposed || baseFailureReason !== null) return;
    const detail = error instanceof Error ? error.message : String(error);
    baseFailureReason = `${label}: ${detail}`;
  };
  // base画像のテクスチャと、フレームごとに書き換える天体の形・姿勢のuniform。
  const ownedBaseColor = sharedBaseColor === undefined ? new DeferredTexture(
    baseColorUrl, THREE.SRGBColorSpace, (error) => recordBaseFailure('Earth base color unavailable', error),
  ) : null;
  const baseColor = sharedBaseColor ?? ownedBaseColor!.texture;
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
      { ...textures, baseColor, baseTerrain: baseTerrain.texture },
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
    ownedBaseColor?.dispose();
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
    deferredTextures: ownedBaseColor === null ? [] : [ownedBaseColor],
    textures: [baseTerrain.texture],
    failureReason: () => baseFailureReason,
    ready: () => ownedBaseColor === null || ownedBaseColor.generation > 0,
    prepare: () => ownedBaseColor?.request(),
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
