import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { ProteinRibbonCollisionGeometry } from '../../src/game/protein/protein-ribbon-collision';
import { v3 } from '../../src/math/vec3';
import { test } from '../harness';

export function register(): void {
  test('protein ribbon collision: uses tagged mesh triangles instead of the outer sphere', () => {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const root = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData.proteinRibbon = true;
    root.add(mesh);

    const collision = new ProteinRibbonCollisionGeometry(root, 1);
    const hit = collision.testSphereCollision(v3(0, 0, 0.1), 0.2, v3(), identity);
    assert.ok(hit, 'a sphere overlapping the ribbon plane should hit');
    assert.ok(Math.abs(hit!.point.z) < 1e-9, 'the reported point should lie on the ribbon mesh');

    const miss = collision.testSphereCollision(v3(0, 0, 3), 0.2, v3(), identity);
    assert.equal(miss, null, 'a sphere outside the ribbon mesh should miss');

    const swept = collision.testSweptSphereCollision(
      v3(0, 0, 2), v3(0, 0, -2), 0.2,
      { r: v3() }, { r: v3() }, identity,
    );
    assert.ok(swept, 'a sphere crossing the ribbon between frames should hit');
    assert.ok(swept!.toi > 0 && swept!.toi < 1, 'the swept hit should report an interior toi');

    geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
}
