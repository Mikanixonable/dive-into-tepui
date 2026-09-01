import * as THREE from 'three/webgpu';

// All projectile meshes are authored with their longitudinal axis on +Z.
const PROJECTILE_FORWARD = new THREE.Vector3(0, 0, 1);
const normalizedVelocity = new THREE.Vector3();

// Align the mesh's authored forward axis with the velocity used for display.
// Keeping this in one place prevents lookAt(-Z) and setFromUnitVectors(+Z, ...)
// from drifting apart again.
export function orientProjectile(quaternion: THREE.Quaternion, velocity: THREE.Vector3): boolean {
  if (velocity.lengthSq() <= 1e-12) return false;
  normalizedVelocity.copy(velocity).normalize();
  quaternion.setFromUnitVectors(PROJECTILE_FORWARD, normalizedVelocity);
  return true;
}
