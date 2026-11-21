// 地球表面のfallback、配信bootstrap、GPU常駐、詳細材質を組み合わせる描画側composition root。
import type { WebGPURenderer } from 'three/webgpu';
import { CelestialSurface } from './celestial/celestial-surface';
import { EarthSurface, EarthSurfaceContext } from './earth-surface';
import type {
  EarthSurfaceDetailConnection, EarthSurfaceDetailConnector,
  EarthSurfaceMaterialAttachment, EarthSurfaceStatus,
} from './earth-surface';
import { EARTH_TILE_LAYERS } from './earth-surface-tile-key';
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
import type { CelestialTexture } from './celestial-textures';
import earthSmoothnessUrl from '../assets/earth-smoothness.png';
import earthSmoothness2048Url from '../assets/earth-smoothness-2048.png';
import { earthSurfaceColorToRgba8 } from './earth-surface-color';
import type { TextureUrls } from './deferred-texture';

// 地表の滑らかさ画像。4096px は原寸と同じ幅なので、縮小版を持つのは低の段だけ。
const EARTH_SMOOTHNESS_URLS: TextureUrls = {
  low: earthSmoothness2048Url, medium: earthSmoothnessUrl, high: earthSmoothnessUrl,
};

interface EarthSurfaceFactoryOptions extends EarthSurfaceBootstrapOptions {
  readonly renderer?: WebGPURenderer | null;
  readonly colorToRgba8?: EarthSurfaceColorToRgba8;
  readonly decodeImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
}

interface EarthSurfaceFactoryResult {
  readonly surface: EarthSurface;
  readonly state: EarthSurfaceStatus;
  readonly bootstrap: EarthSurfaceBootstrapResult;
}

interface EarthSurfaceRuntimeHandle {
  readonly surface: EarthSurface;
  readonly ready: Promise<EarthSurfaceFactoryResult>;
}

// 起動直後に表示する8K全球画像を持つfallbackを返す。
function fallbackSurface(
  status: EarthSurfaceStatus = 'loading',
  detailConnector: EarthSurfaceDetailConnector | null = null,
): EarthSurface {
  const fallback = CelestialSurface.textured(EARTH_TEXTURE, EARTH_SMOOTHNESS_URLS);
  return new EarthSurface(
    new EarthSurfaceContext(EARTH_SURFACE_FIXTURE_SOURCE),
    fallback,
    null,
    status,
    null,
    detailConnector,
  );
}

// manifestのbase色と同じ校正値を即時全球表示にも使う。古い静的画像はmanifest失敗時だけ残る。
function fallbackTextureFor(source: EarthSurfaceSource): CelestialTexture {
  return {
    url: source.baseColorUrl,
    albedoScale: source.colorCalibration.diffuseAlbedoScale,
    bondAlbedo: source.colorCalibration.bondAlbedo,
    averageHue: source.colorCalibration.averageHue,
  };
}

// GPUテクスチャとmanifestのbase画像から、地表材質の寿命管理をまとめて返す。
function detailedMaterialFor(
  source: EarthSurfaceSource, textures: EarthSurfaceGpuTextures, fetchImpl?: typeof fetch,
): EarthSurfaceMaterialAttachment {
  // 材質バインディングのインターフェースを runtime attachment へ変換する。
  const binding = createEarthSurfaceMaterialBinding(
    textures, source.baseColorUrl, source.baseTerrainUrl, fetchImpl,
    source.colorCalibration.diffuseAlbedoScale,
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

// bootstrap済み契約を、GPU能力に応じて詳細接続または全球表示へフォールバックする。
// tileLayers は配列へ張る物理層数で、テクスチャ解像度の段から呼び側が決める。
function coordinatorFor(
  bootstrap: EarthSurfaceBootstrapResult, options: EarthSurfaceFactoryOptions,
  tileLayers: number,
): EarthSurfaceDetailConnection {
  // 起動結果とGPU能力を接続し、利用できない場合は全球表示へ戻す。
  if (bootstrap.state !== 'ready') {
    return {
      coordinator: null,
      status: bootstrap.state,
      material: null,
      reason: bootstrap.state === 'error'
        ? bootstrap.error?.message ?? 'earth surface bootstrap failed'
        : 'earth surface manifest unavailable',
    };
  }
  if (options.renderer === null || options.renderer === undefined) {
    return { coordinator: null, status: 'fallback', material: null, reason: 'renderer unavailable' };
  }
  if (bootstrap.tileSource === null) {
    return { coordinator: null, status: 'fallback', material: null, reason: 'tile source unavailable' };
  }
  const backend = options.renderer.backend as unknown as EarthSurfaceGpuThreeBackendLike | null;
  if (backend == null) {
    return { coordinator: null, status: 'fallback', material: null, reason: 'WebGPU backend unavailable' };
  }
  const queue = new EarthSurfaceTileRequestQueue(bootstrap.tileSource, {
    fetchImpl: options.fetchImpl,
    decodeImage: options.decodeImage,
  });
  const three = createEarthSurfaceGpuThree(backend, tileLayers);
  if (three.textures === null) {
    queue.dispose();
    three.dispose();
    return { coordinator: null, status: 'fallback', material: null, reason: 'WebGPU detail features unavailable' };
  }
  const gpu = new EarthSurfaceGpuAdapter(three, tileLayers);
  const textures = gpu.textures;
  if (textures === null) {
    queue.dispose();
    gpu.dispose();
    return { coordinator: null, status: 'fallback', material: null, reason: 'detail textures unavailable' };
  }
  let material: EarthSurfaceMaterialAttachment;
  try {
    material = detailedMaterialFor(bootstrap.source!, textures, options.fetchImpl);
  } catch (error: unknown) {
    queue.dispose();
    gpu.dispose();
    const message = error instanceof Error ? error.message : String(error);
    return { coordinator: null, status: 'fallback', material: null, reason: `detail material unavailable: ${message}` };
  }
  return {
    coordinator: new EarthSurfaceResidentCoordinator({
      tiles: new EarthSurfaceTiles(bootstrap.source!.maxZoom),
      queue,
      gpu,
      colorToRgba8: options.colorToRgba8 ?? earthSurfaceColorToRgba8,
    }),
    status: 'ready',
    material,
    reason: null,
  };
}

// 画像球を即座に返し、manifest・GPUが準備できたら同じ地表へ詳細材質を付ける。
// テクスチャ解像度の段が変わると、地表側から connector.connect が呼ばれて詳細接続が組み直される。
export function createEarthSurfaceRuntime(options: EarthSurfaceFactoryOptions = {}): EarthSurfaceRuntimeHandle {
  // manifestが届くまで組めないので、要求された層数は届くまでのあいだ保持する。
  let bootstrap: EarthSurfaceBootstrapResult | null = null;
  let tileLayers = EARTH_TILE_LAYERS;
  const connector: EarthSurfaceDetailConnector = {
    connect: (nextLayers) => {
      tileLayers = nextLayers;
      return bootstrap === null ? null : coordinatorFor(bootstrap, options, nextLayers);
    },
  };
  const surface = fallbackSurface('loading', connector);
  const ready = bootstrapEarthSurface({
    ...options,
    fallback: options.fallback ?? EARTH_SURFACE_FIXTURE_SOURCE,
  }).then((result) => {
    bootstrap = result;
    // 起動結果をsurfaceへ反映し、詳細接続の待機を終える。
    const source = result.source ?? EARTH_SURFACE_FIXTURE_SOURCE;
    if (result.state === 'ready') {
      surface.replaceFallback(CelestialSurface.textured(fallbackTextureFor(source), EARTH_SMOOTHNESS_URLS));
    }
    const connection = coordinatorFor(result, options, tileLayers);
    surface.attach(source, connection.coordinator, connection.status, connection.material, connection.reason);
    return { surface, state: connection.status, bootstrap: result };
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


