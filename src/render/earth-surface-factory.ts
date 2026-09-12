// 地球表面のfallback、配信bootstrap、GPU常駐、詳細材質を組み合わせる描画側composition root。
import type { Texture, WebGPURenderer } from 'three/webgpu';
import { CelestialSurface } from './celestial/celestial-surface';
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
import earthSmoothnessUrl from '../assets/earth-smoothness.png';
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

// 起動直後の8K全球画像と、その画像を詳細材質でも共有するための参照を返す。
function fallbackSurface(status: EarthSurfaceStatus = 'loading'): {
  readonly surface: EarthSurface; readonly baseColorTexture: Texture;
} {
  const fallback = CelestialSurface.textured(EARTH_TEXTURE, earthSmoothnessUrl);
  return { surface: new EarthSurface(
    new EarthSurfaceContext(EARTH_SURFACE_FIXTURE_SOURCE),
    fallback,
    null,
    status,
  ), baseColorTexture: fallback.baseColorTexture! };
}

interface EarthSurfaceConnection {
  readonly coordinator: EarthSurfaceResidentCoordinator | null;
  readonly state: EarthSurfaceStatus;
  readonly material: EarthSurfaceMaterialAttachment | null;
  readonly reason: string | null;
}

// GPUテクスチャと共有base画像から、地表材質の寿命管理をまとめて返す。
function detailedMaterialFor(
  source: EarthSurfaceSource, textures: EarthSurfaceGpuTextures, fetchImpl?: typeof fetch,
  sharedBaseColor?: Texture,
): EarthSurfaceMaterialAttachment {
  // 材質bindingの公開契約をruntime attachmentへ写す。
  const binding = createEarthSurfaceMaterialBinding(
    textures, source.baseColorUrl, source.baseTerrainUrl, fetchImpl, sharedBaseColor,
  );
  return {
    material: binding.material,
    deferred: binding.deferredTextures,
    textures: binding.textures,
    onDispose: binding.dispose,
    failureReason: binding.failureReason,
    ready: binding.ready,
    prepare: binding.prepare,
    syncFrame: binding.syncFrame,
  };
}

// bootstrap済み契約を、GPU能力に応じて詳細接続または全球表示へ落とす。
function coordinatorFor(
  bootstrap: EarthSurfaceBootstrapResult, options: EarthSurfaceFactoryOptions, sharedBaseColor?: Texture,
): EarthSurfaceConnection {
  // 起動結果とGPU能力を接続し、利用できない場合は全球表示へ戻す。
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
    material = detailedMaterialFor(bootstrap.source!, textures, options.fetchImpl, sharedBaseColor);
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
  const fallback = fallbackSurface();
  const surface = fallback.surface;
  const ready = bootstrapEarthSurface({
    ...options,
    fallback: options.fallback ?? EARTH_SURFACE_FIXTURE_SOURCE,
  }).then((bootstrap) => {
    // 起動結果をsurfaceへ反映し、詳細接続の待機を終える。
    const source = bootstrap.source ?? EARTH_SURFACE_FIXTURE_SOURCE;
    const connection = coordinatorFor(bootstrap, options, fallback.baseColorTexture);
    surface.attach(source, connection.coordinator, connection.state, connection.material, connection.reason);
    return { surface, state: connection.state, bootstrap };
  }).catch((error: unknown) => {
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

// runtimeのready完了まで待ち、surfaceと最終状態を返す。
export async function createEarthSurface(options: EarthSurfaceFactoryOptions = {}): Promise<EarthSurfaceFactoryResult> {
  // 起動時の全球表示を返し、詳細接続の完了を待って最終状態を返す。
  return createEarthSurfaceRuntime(options).ready;
}
