// 地球表面の描画契約への委譲と、共有コンテキストを先に破棄する順序を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { EarthSurface, EarthSurfaceContext } from '../../src/render/earth-surface';
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

function frame(): CelestialSurfaceFrame {
  return {
    camera: new THREE.PerspectiveCamera(),
    bodyToView: new THREE.Matrix4(),
    axes: new THREE.Vector3(1, 1, 1),
    viewport: { width: 320, height: 200 },
    frame: 7,
    timeMs: 1200,
    style: 'realistic',
  };
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
}
