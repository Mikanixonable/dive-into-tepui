import * as THREE from 'three/webgpu';

// 弾頭メッシュの長軸方向は +Z で統一されている。
const PROJECTILE_FORWARD = new THREE.Vector3(0, 0, 1);
const normalizedVelocity = new THREE.Vector3();

// 弾頭の前方軸 (+Z) を表示速度ベクトルの向きへ整列させる。
export function orientProjectile(quaternion: THREE.Quaternion, velocity: THREE.Vector3): boolean {
  if (velocity.lengthSq() <= 1e-12) return false;
  normalizedVelocity.copy(velocity).normalize();
  quaternion.setFromUnitVectors(PROJECTILE_FORWARD, normalizedVelocity);
  return true;
}
