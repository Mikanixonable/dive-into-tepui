import * as THREE from 'three/webgpu';

type Drawable = THREE.Object3D & {
  readonly geometry?: THREE.BufferGeometry;
  readonly material?: THREE.Material | THREE.Material[];
};

// root 以下を歩き、userData.ownsGeometry / userData.ownsMaterial の印が立った描画物
// (Mesh・Line・LineSegments など、geometry/material を持つものすべて)だけ geometry/material
// を dispose する。印の無いものは共有物とみなして触らない。
export function disposeOwnedResources(root: THREE.Object3D): void {
  root.traverse((child) => {
    const drawable = child as Drawable;
    if (drawable.userData.ownsGeometry && drawable.geometry) {
      drawable.geometry.dispose();
    }
    if (drawable.userData.ownsMaterial && drawable.material) {
      if (Array.isArray(drawable.material)) drawable.material.forEach((m) => m.dispose());
      else drawable.material.dispose();
    }
  });
}
