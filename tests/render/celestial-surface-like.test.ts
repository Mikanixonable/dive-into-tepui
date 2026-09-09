// 天体表面の共通契約。既存CelestialSurfaceを差し替え可能な型として受けられることを固定する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { CelestialSurface } from '../../src/render/celestial-surface';
import type { CelestialSurfaceLike } from '../../src/render/celestial-surface';
import { test } from '../harness';

function frame(): Parameters<CelestialSurfaceLike['syncFrame']>[0] {
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
  test('celestial surface like: 既存の静的surfaceは共通契約へ適合する', () => {
    const surface: CelestialSurfaceLike = CelestialSurface.solid([0.2, 0.3, 0.4]);
    const parent = new THREE.Group();
    surface.addTo(parent);
    surface.syncLod(16);
    surface.syncFrame(frame());
    assert.equal(parent.children.length, 3);
    assert.equal(surface.textureUrl, null);
    assert.ok(surface.photometry !== null);
    surface.hide();
    surface.dispose();
  });
}
