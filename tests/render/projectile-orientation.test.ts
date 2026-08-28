import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { orientProjectile } from '../../src/render/projectile-orientation';

export function register(): void {
  test('projectile orientation: authored +Z follows the displayed velocity', () => {
    const quaternion = new THREE.Quaternion();
    assert.equal(orientProjectile(quaternion, new THREE.Vector3(4, -2, 3)), true);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
    const expected = new THREE.Vector3(4, -2, 3).normalize();
    assert.ok(forward.distanceTo(expected) < 1e-6);
  });

  test('projectile orientation: zero velocity leaves the existing orientation intact', () => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.4, 0.6));
    const before = quaternion.clone();
    assert.equal(orientProjectile(quaternion, new THREE.Vector3()), false);
    assert.ok(quaternion.equals(before));
  });
}
