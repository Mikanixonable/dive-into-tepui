import * as THREE from 'three/webgpu';

// root 以下を歩き、userData.ownsGeometry / ownsMaterial の印が立ったメッシュだけ
// geometry/material を dispose する。印の無いメッシュは共有物とみなして触らない。
export function disposeOwnedResources(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.ownsGeometry && mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.userData.ownsMaterial && mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    }
  });
}
