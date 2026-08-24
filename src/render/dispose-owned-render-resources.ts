import * as THREE from 'three/webgpu';

export function disposeOwnedRenderResources(root: THREE.Object3D): void {
  root.traverse((child) => {
    const renderable = child as THREE.Mesh & { isLine?: boolean; isLineSegments?: boolean };
    if (!renderable.isMesh && !renderable.isLine && !renderable.isLineSegments) return;
    if (renderable.userData.ownsGeometry && renderable.geometry) renderable.geometry.dispose();
    if (renderable.userData.ownsMaterial && renderable.material) {
      if (Array.isArray(renderable.material)) renderable.material.forEach((material) => material.dispose());
      else renderable.material.dispose();
    }
  });
}
