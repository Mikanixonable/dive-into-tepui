import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { disposeOwnedRenderResources } from '../../src/render/dispose-owned-render-resources';
import { test } from './harness';

export function register(): void {
  test('game entity dispose: owned lines are released without touching shared resources', () => {
    const root = new THREE.Group();
    const owned = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    const shared = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    owned.userData.ownsGeometry = owned.userData.ownsMaterial = true;
    let ownedGeometry = 0; let ownedMaterial = 0; let sharedGeometry = 0; let sharedMaterial = 0;
    owned.geometry.dispose = () => { ownedGeometry++; };
    (owned.material as THREE.Material).dispose = () => { ownedMaterial++; };
    shared.geometry.dispose = () => { sharedGeometry++; };
    (shared.material as THREE.Material).dispose = () => { sharedMaterial++; };
    root.add(owned, shared);
    disposeOwnedRenderResources(root);
    assert.deepEqual([ownedGeometry, ownedMaterial, sharedGeometry, sharedMaterial], [1, 1, 0, 0]);
  });
}
