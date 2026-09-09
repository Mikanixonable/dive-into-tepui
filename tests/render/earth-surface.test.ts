// 地球表面の描画契約への委譲と、共有コンテキストを先に破棄する順序を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { EarthSurface, EarthSurfaceContext } from '../../src/render/earth-surface';
import { EarthSurfaceView } from '../../src/render/earth-surface-tiles';
import type { EarthSurfaceResidentFrame } from '../../src/render/earth-surface-resident';
import type { EarthSurfaceSource } from '../../src/game/celestial/solar-system/earth-surface-source';
import type {
  CelestialSurfaceFrame,
  CelestialSurfaceLike,
  SurfacePhotometry,
} from '../../src/render/celestial-surface';

const SOURCE = {
  datasetId: 'earth-test',
  sourceManifestSha256: '0'.repeat(64),
  climateEncoding: {
    temperatureK: { min: 180, max: 330 },
    cloudFraction: { min: 0, max: 1 },
    orthometricElevation: { min: -1000, max: 9000 },
    landFraction: { min: 0, max: 1 },
  },
  baseUrl: 'https://example.test/earth/',
  manifestUrl: 'https://example.test/earth/manifest.json',
  tileIndexUrl: 'https://example.test/earth/tile-index.json',
  baseColorUrl: 'https://example.test/earth/base-color.jpg',
  baseTerrainUrl: 'https://example.test/earth/base-terrain.bin.gz',
  climateMapUrls: [],
} satisfies EarthSurfaceSource;

class FallbackSpy implements CelestialSurfaceLike {
  public readonly photometry: SurfacePhotometry | null = null;
  public readonly textureUrl = 'fallback.jpg';
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

    surface.syncFrame({ ...frame(camera), frame: 8 });
    assert.equal(coordinator.frames.length, 2);
    assert.equal(firstSignal?.aborted, false);
    assert.equal(coordinator.frames[1]?.signal, firstSignal);
    assert.equal(coordinator.frames[1]?.signal?.aborted, false);

    surface.hide();
    assert.equal(coordinator.frames[1]?.signal?.aborted, true);
    assert.equal(context.generation, 2);
    surface.dispose();
    assert.equal(coordinator.disposed, true);
    surface.dispose();
  });
}
