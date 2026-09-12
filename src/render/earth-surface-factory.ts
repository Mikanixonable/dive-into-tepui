// 地球表面のfallback、配信bootstrap、GPU常駐、詳細材質を組み合わせる描画側composition root。
import type { WebGPURenderer } from 'three/webgpu';
import { CelestialSurface } from './celestial/celestial-surface';
import earthSmoothnessUrl from '../assets/earth-smoothness.png';
import { EarthSurface, EarthSurfaceContext } from './earth-surface';
import type { EarthSurfaceMaterialAttachment, EarthSurfaceStatus } from './earth-surface';
import { EarthSurfaceResidentCoordinator } from './earth-surface-resident';
import type { EarthSurfaceColorToRgba8 } from './earth-surface-resident';
import { EarthSurfaceTileRequestQueue } from './earth-surface-tile-queue';
import { EarthSurfaceTiles } from './earth-surface-tiles';
import { EarthSurfaceGpuAdapter } from './earth-surface-gpu';
import type { EarthSurfaceGpuTextures } from './earth-surface-gpu';
import { createEarthSurfaceGpuThree, type EarthSurfaceGpuThreeBackendLike } from './earth-surface-gpu-three';
import { createEarthSurfaceMaterialBinding } from './earth-surface-material-binding';
import { bootstrapEarthSurface } from './earth-surface-runtime';
import type { EarthSurfaceBootstrapOptions, EarthSurfaceBootstrapResult } from './earth-surface-runtime';
import type { EarthSurfaceSource } from './earth-surface-source';
import { EARTH_SURFACE_FIXTURE_SOURCE, EARTH_TEXTURE } from './earth-surface-defaults';
import { earthSurfaceColorToRgba8 } from './earth-surface-color';

export interface EarthSurfaceFactoryOptions extends EarthSurfaceBootstrapOptions {
  readonly renderer?: WebGPURenderer | null;
  readonly colorToRgba8?: EarthSurfaceColorToRgba8;
  readonly decodeImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
}

export interface EarthSurfaceFactoryResult {
  readonly surface: EarthSurface;
  readonly state: EarthSurfaceStatus;
  readonly bootstrap: EarthSurfaceBootstrapResult;
}

export interface EarthSurfaceRuntimeHandle {
  readonly surface: EarthSurface;
  readonly ready: Promise<EarthSurfaceFactoryResult>;
}

// 開発用のfallback入力から、詳細材質を持たない地表を組む。
function fallbackSurface(status: EarthSurfaceStatus = 'loading'): EarthSurface {
  return new EarthSurface(
    new EarthSurfaceContext(EARTH_SURFACE_FIXTURE_SOURCE),
    CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl),
    null,
    status,
  );
}

interface EarthSurfaceConnection {
  readonly coordinator: EarthSurfaceResidentCoordinator | null;
  readonly state: EarthSurfaceStatus;
  readonly material: EarthSurfaceMaterialAttachment | null;
  readonly reason: string | null;
}

// GPUテクスチャと配信物のbase画像を詳細材質へ束ねる。
function detailedMaterialFor(
  source: EarthSurfaceSource, textures: EarthSurfaceGpuTextures, fetchImpl?: typeof fetch,
): EarthSurfaceMaterialAttachment {
  // GPU常駐テクスチャと配信物のbase画像を1つの材質へ束ねる。
  const binding = createEarthSurfaceMaterialBinding(textures, source.baseColorUrl, source.baseTerrainUrl, fetchImpl);
  return {
    material: binding.material,
    deferred: binding.deferredTextures,
    textures: binding.textures,
    onDispose: binding.dispose,
    failureReason: binding.failureReason,
    syncFrame: binding.syncFrame,
  };
}

// bootstrap結果とGPU能力から、詳細地表を使える接続を選ぶ。
function coordinatorFor(
  bootstrap: EarthSurfaceBootstrapResult, options: EarthSurfaceFactoryOptions,
): EarthSurfaceConnection {
  // 配信結果とGPU能力から、詳細地表へ接続できる資源一式を選ぶ。
  if (bootstrap.state !== 'ready') {
    return {
      coordinator: null,
      state: bootstrap.state,
      material: null,
      reason: bootstrap.state === 'error'
        ? bootstrap.error?.message ?? 'earth surface bootstrap failed'
        : 'earth surface manifest unavailable',
    };
  }
  if (options.renderer === null || options.renderer === undefined) {
    return { coordinator: null, state: 'fallback', material: null, reason: 'renderer unavailable' };
  }
  if (bootstrap.tileSource === null) {
    return { coordinator: null, state: 'fallback', material: null, reason: 'tile source unavailable' };
  }
  // WebGPUの配列テクスチャを確保し、対応できない環境はfallbackへ戻す。
  const backend = options.renderer.backend as unknown as EarthSurfaceGpuThreeBackendLike | null | undefined;
  if (backend === null || backend === undefined) {
    return { coordinator: null, state: 'fallback', material: null, reason: 'WebGPU backend unavailable' };
  }
  const queue = new EarthSurfaceTileRequestQueue(bootstrap.tileSource, {
    fetchImpl: options.fetchImpl,
    decodeImage: options.decodeImage,
  });
  const gpu = new EarthSurfaceGpuAdapter(createEarthSurfaceGpuThree(backend));
  if (gpu.mode === 'base') {
    queue.dispose();
    gpu.dispose();
    return { coordinator: null, state: 'fallback', material: null, reason: 'WebGPU detail features unavailable' };
  }
  const textures = gpu.textures;
  if (textures === null) {
    queue.dispose();
    gpu.dispose();
    return { coordinator: null, state: 'fallback', material: null, reason: 'detail textures unavailable' };
  }
  let material: EarthSurfaceMaterialAttachment;
  try {
    // 材質の構築に失敗したときは、先に確保したGPU資源も同時に解放する。
    material = detailedMaterialFor(bootstrap.source!, textures, options.fetchImpl);
  } catch (error: unknown) {
    queue.dispose();
    gpu.dispose();
    const message = error instanceof Error ? error.message : String(error);
    return { coordinator: null, state: 'fallback', material: null, reason: `detail material unavailable: ${message}` };
  }
  return {
    coordinator: new EarthSurfaceResidentCoordinator({
      tiles: new EarthSurfaceTiles(),
      queue,
      gpu,
      colorToRgba8: options.colorToRgba8 ?? earthSurfaceColorToRgba8,
    }),
    state: 'ready',
    material,
    reason: null,
  };
}

// 画像球を即座に返し、manifest・GPUが準備できたら同じ地表へ詳細材質を付ける。
export function createEarthSurfaceRuntime(options: EarthSurfaceFactoryOptions = {}): EarthSurfaceRuntimeHandle {
  // まず画像球を公開し、非同期の配信結果を同じ地表へ接続する。
  const surface = fallbackSurface();
  const ready = bootstrapEarthSurface({
    ...options,
    fallback: options.fallback ?? EARTH_SURFACE_FIXTURE_SOURCE,
  }).then((bootstrap) => {
    // 配信結果に応じて詳細coordinatorまたはfallback状態を接続する。
    const source = bootstrap.source ?? EARTH_SURFACE_FIXTURE_SOURCE;
    const connection = coordinatorFor(bootstrap, options);
    surface.attach(source, connection.coordinator, connection.state, connection.material, connection.reason);
    return { surface, state: connection.state, bootstrap };
  }).catch((error: unknown) => {
    // 非同期失敗時も表示可能なfallbackと診断状態を返す。
    const fallback = options.fallback ?? EARTH_SURFACE_FIXTURE_SOURCE;
    const reason = error instanceof Error ? error.message : String(error);
    surface.attach(fallback, null, 'error', null, reason);
    return {
      surface,
      state: 'error' as const,
      bootstrap: {
        state: 'error' as const, source: fallback, tileSource: null,
        error: error instanceof Error ? error : new Error(reason),
      },
    };
  });
  return { surface, ready };
}

// 地表ランタイムの非同期準備が完了するまで待って結果を返す。
export async function createEarthSurface(options: EarthSurfaceFactoryOptions = {}): Promise<EarthSurfaceFactoryResult> {
  return createEarthSurfaceRuntime(options).ready;
}
