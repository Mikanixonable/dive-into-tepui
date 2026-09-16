// 地球表面の描画契約への委譲と、共有コンテキストを先に破棄する順序を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { EarthSurface, EarthSurfaceContext } from '../../src/render/earth-surface';
import { CelestialSurface } from '../../src/render/celestial/celestial-surface';
import { EarthSurfaceGpuThree } from '../../src/render/earth-surface-gpu-three';
import { createEarthSurfaceMaterialBinding } from '../../src/render/earth-surface-material-binding';
import type { EarthSurfaceGpuTextures } from '../../src/render/earth-surface-gpu';
import { EARTH_TILE_LAYERS } from '../../src/render/earth-surface-tile-key';
import { EarthSurfaceView } from '../../src/render/earth-surface-tile-projection';
import type { EarthSurfaceResidentFrame } from '../../src/render/earth-surface-resident';
import type { EarthSurfaceSource } from '../../src/render/earth-surface-source';
import type {
  CelestialSurfaceFrame,
  CelestialSurfaceLike,
  SurfacePhotometry,
} from '../../src/render/celestial/celestial-surface';

const SOURCE = {
  datasetId: 'earth-test',
  sourceManifestSha256: '0'.repeat(64),
  climateEncoding: {
    temperatureK: { min: 180, max: 330 },
    cloudFraction: { min: 0, max: 1 },
    orthometricElevation: { min: -1000, max: 9000 },
    landFraction: { min: 0, max: 1 },
    waterOrthometricElevationM: 0,
  },
  baseUrl: 'https://example.test/earth/',
  manifestUrl: 'https://example.test/earth/manifest.json',
  colorTileTemplate: 'https://example.test/earth/tiles/{z}/{x}/{y}.jpg',
  terrainTileTemplate: 'https://example.test/earth/tiles/{z}/{x}/{y}.bin.gz',
  baseColorUrl: 'https://example.test/earth/base-color.jpg',
  baseTerrainUrl: 'https://example.test/earth/base-terrain.bin.gz',
  climateMapUrls: [],
} satisfies EarthSurfaceSource;

class FallbackSpy implements CelestialSurfaceLike {
  public readonly photometry: SurfacePhotometry | null = null;
  public readonly textureUrl = 'fallback.jpg';
  public readonly diagnostics = null;
  public readonly calls: string[] = [];

  public addTo(_parent: THREE.Object3D): void { this.calls.push('addTo'); }
  public syncLod(_apparentDiameterPx: number): void { this.calls.push('syncLod'); }
  public syncFrame(_frame: CelestialSurfaceFrame): void { this.calls.push('syncFrame'); }
  public hide(): void { this.calls.push('hide'); }
  public dispose(): void { this.calls.push('dispose'); }
}

function frame(camera: THREE.Camera = new THREE.Camera()): CelestialSurfaceFrame {
  return {
    camera,
    bodyToView: new THREE.Matrix4(),
    axes: new THREE.Vector3(1, 1, 1),
    viewport: { width: 320, height: 200 },
    frame: 7,
    timeMs: 1200,
    style: 'realistic',
  };
}

class CoordinatorSpy {
  public readonly frames: EarthSurfaceResidentFrame[] = [];
  public disposed = false;
  public residentMaxZ: number | null = null;
  public failureReason: string | null = null;

  public constructor(public readonly textures?: EarthSurfaceGpuTextures | null) {}

  public sync(input: EarthSurfaceResidentFrame): void { this.frames.push(input); }
  public dispose(): void { this.disposed = true; }
}

export function register(): void {
  test('earth surface: 描画契約をfallbackへ委譲しcontextを先に破棄する', () => {
    const context = new EarthSurfaceContext(SOURCE);
    const fallback = new FallbackSpy();
    const surface: CelestialSurfaceLike = new EarthSurface(context, fallback);
    const parent = new THREE.Group();

    assert.equal(surface.photometry, fallback.photometry);
    assert.equal(surface.textureUrl, fallback.textureUrl);
    surface.addTo(parent);
    surface.syncLod(32);
    surface.syncFrame(frame());
    surface.hide();
    assert.deepEqual(fallback.calls, ['addTo', 'syncLod', 'syncFrame', 'hide']);

    const lease = context.requestLease();
    surface.dispose();
    assert.deepEqual(fallback.calls, ['addTo', 'syncLod', 'syncFrame', 'hide', 'dispose']);
    assert.equal(lease.signal.aborted, true);
    assert.throws(() => context.requestLease(), /disposed/);
  });

  test('earth surface: diagnosticsは状態・理由・詳細材質・常駐LODを返す', () => {
    const context = new EarthSurfaceContext(SOURCE);
    const fallback = new FallbackSpy();
    const coordinator = new CoordinatorSpy();
    const surface = new EarthSurface(context, fallback, coordinator, 'loading', 'manifest pending');

    assert.deepEqual(surface.diagnostics, {
      status: 'loading', reason: 'manifest pending', usesDetailedMaterial: false, residentMaxZ: null,
    });
    coordinator.residentMaxZ = 3;
    surface.attach(SOURCE, coordinator, 'ready');
    assert.deepEqual(surface.diagnostics, {
      status: 'ready', reason: null, usesDetailedMaterial: false, residentMaxZ: 3,
    });
    coordinator.failureReason = 'tile 0/0/0: color conversion failed';
    assert.deepEqual(surface.diagnostics, {
      status: 'ready', reason: 'tile 0/0/0: color conversion failed',
      usesDetailedMaterial: false, residentMaxZ: 3,
    });

    surface.attach(SOURCE, null, 'fallback', null, 'WebGPU detail features unavailable');
    assert.deepEqual(surface.diagnostics, {
      status: 'fallback', reason: 'WebGPU detail features unavailable',
      usesDetailedMaterial: false, residentMaxZ: null,
    });
    surface.dispose();
  });

  test('earth surface: frameからprojectionを作りcoordinatorへ世代付きで渡す', () => {
    const context = new EarthSurfaceContext(SOURCE);
    const fallback = new FallbackSpy();
    const coordinator = new CoordinatorSpy();
    const surface = new EarthSurface(context, fallback, coordinator);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    surface.syncFrame(frame(camera));
    assert.equal(coordinator.frames.length, 1);
    assert.ok(coordinator.frames[0]?.projection instanceof EarthSurfaceView);
    assert.equal(coordinator.frames[0]?.generation, 1);
    assert.equal(coordinator.frames[0]?.frame, 7);
    assert.equal(coordinator.frames[0]?.signal?.aborted, false);
    const firstSignal = coordinator.frames[0]?.signal;

    surface.syncFrame({ ...frame(camera), frame: 8, timeMs: 1201 });
    assert.equal(coordinator.frames.length, 2);
    assert.equal(coordinator.frames[1]?.projection, coordinator.frames[0]?.projection);
    assert.equal(firstSignal?.aborted, false);
    assert.equal(coordinator.frames[1]?.signal, firstSignal);
    assert.equal(coordinator.frames[1]?.signal?.aborted, false);

    camera.position.x = 1;
    camera.updateMatrixWorld();
    surface.syncFrame({ ...frame(camera), frame: 9, timeMs: 1250 });
    assert.equal(coordinator.frames[2]?.projection, coordinator.frames[1]?.projection);
    surface.syncFrame({ ...frame(camera), frame: 10, timeMs: 1300 });
    assert.notEqual(coordinator.frames[3]?.projection, coordinator.frames[2]?.projection);
    const beforeRewind = coordinator.frames[3]?.projection;
    surface.syncFrame({ ...frame(camera), frame: 11, timeMs: 1299 });
    assert.notEqual(coordinator.frames[4]?.projection, beforeRewind);
    const beforeJump = coordinator.frames[4]?.projection;
    surface.syncFrame({ ...frame(camera), frame: 12, timeMs: 2000 });
    assert.equal(coordinator.frames[5]?.projection, beforeJump);

    surface.hide();
    assert.equal(coordinator.frames[1]?.signal?.aborted, true);
    assert.equal(context.generation, 2);
    surface.dispose();
    assert.equal(coordinator.disposed, true);
    surface.dispose();
  });

  test('earth surface: 対応GPUのcoordinatorをattachすると既存LODメッシュへ材質を接続する', async () => {
    const gpu = new EarthSurfaceGpuThree({
      texture2dArray: true, maxTextureArrayLayers: EARTH_TILE_LAYERS,
      colorSrgbLinear: true, terrainRgba8Linear: true,
    });
    const coordinator = new CoordinatorSpy(gpu.textures);
    const fallback = CelestialSurface.solid([0.1, 0.1, 0.1]);
    const surface = new EarthSurface(new EarthSurfaceContext(SOURCE), fallback);
    const parent = new THREE.Group();
    surface.addTo(parent);
    const previousMaterial = (parent.children[0] as THREE.Mesh).material;

    const binding = createEarthSurfaceMaterialBinding(
      gpu.textures!, SOURCE.baseColorUrl, SOURCE.baseTerrainUrl,
      async () => { throw new Error('base terrain fixture is intentionally unavailable'); },
    );
    assert.equal(binding.deferredTextures[0]?.texture.image, null);
    assert.equal(binding.deferredTextures[0]?.texture.version, 0);
    surface.attach(SOURCE, coordinator, 'ready', {
      material: binding.material, deferred: binding.deferredTextures, textures: binding.textures,
      onDispose: binding.dispose, failureReason: binding.failureReason, syncFrame: binding.syncFrame,
    });
    const material = (parent.children[0] as THREE.Mesh).material;
    assert.notEqual(material, previousMaterial);
    assert.ok(material instanceof THREE.MeshStandardNodeMaterial);
    assert.equal(surface.status, 'ready');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.match(surface.diagnostics.reason ?? '', /Earth base terrain unavailable/);

    surface.dispose();
    gpu.dispose();
  });

  test('earth surface: 詳細材質は表示中の8K全球テクスチャを再利用して所有しない', () => {
    const gpu = new EarthSurfaceGpuThree({
      texture2dArray: true, maxTextureArrayLayers: EARTH_TILE_LAYERS,
      colorSrgbLinear: true, terrainRgba8Linear: true,
    });
    const sharedBaseColor = new THREE.Texture();
    let sharedDisposed = false;
    sharedBaseColor.addEventListener('dispose', () => { sharedDisposed = true; });
    const binding = createEarthSurfaceMaterialBinding(
      gpu.textures!, SOURCE.baseColorUrl, SOURCE.baseTerrainUrl,
      async () => { throw new Error('base terrain fixture is intentionally unavailable'); },
      sharedBaseColor,
    );

    assert.equal(binding.deferredTextures.length, 0);
    assert.equal(binding.ready(), true);
    binding.prepare();
    binding.dispose();
    binding.material.dispose();
    for (const texture of binding.textures) texture.dispose();
    assert.equal(sharedDisposed, false);
    sharedBaseColor.dispose();
    gpu.dispose();
  });

  test('earth surface: GPU接続を外すと初期fallback材質へ戻る', () => {
    const gpu = new EarthSurfaceGpuThree({
      texture2dArray: true, maxTextureArrayLayers: EARTH_TILE_LAYERS,
      colorSrgbLinear: true, terrainRgba8Linear: true,
    });
    const coordinator = new CoordinatorSpy(gpu.textures);
    const fallback = CelestialSurface.solid([0.1, 0.1, 0.1]);
    const surface = new EarthSurface(new EarthSurfaceContext(SOURCE), fallback);
    const parent = new THREE.Group();
    surface.addTo(parent);
    const fallbackMaterial = (parent.children[0] as THREE.Mesh).material;

    const binding = createEarthSurfaceMaterialBinding(
      gpu.textures!, SOURCE.baseColorUrl, SOURCE.baseTerrainUrl,
      async () => { throw new Error('base terrain fixture is intentionally unavailable'); },
    );
    surface.attach(SOURCE, coordinator, 'ready', {
      material: binding.material, deferred: binding.deferredTextures, textures: binding.textures,
      onDispose: binding.dispose, failureReason: binding.failureReason, syncFrame: binding.syncFrame,
    });
    surface.attach(SOURCE, null, 'fallback');
    assert.equal((parent.children[0] as THREE.Mesh).material, fallbackMaterial);

    surface.dispose();
    gpu.dispose();
  });

  test('earth surface: source切替は旧coordinatorと詳細材質を同じ境界で解放する', () => {
    const fallback = CelestialSurface.solid([0.1, 0.1, 0.1]);
    const surface = new EarthSurface(new EarthSurfaceContext(SOURCE), fallback);
    const coordinator = new CoordinatorSpy();
    const detailMaterial = new THREE.MeshStandardMaterial();
    let disposed = 0;
    const nextSource = { ...SOURCE, datasetId: 'earth-test-next' };

    surface.attach(SOURCE, coordinator, 'ready', {
      material: detailMaterial,
      deferred: [],
      onDispose: () => { disposed++; },
      syncFrame: () => {},
    });
    surface.attach(nextSource, null, 'fallback');

    assert.equal(coordinator.disposed, true);
    assert.equal(disposed, 1);
    surface.dispose();
  });
}
