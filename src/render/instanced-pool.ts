import * as THREE from 'three/webgpu';

export class InstancedPool {
  private readonly scene: THREE.Scene;
  private readonly added: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, _geometry: THREE.BufferGeometry, _material: THREE.Material, _capacity: number) {
    this.scene = scene;
  }

  beginFrame(): void {
    for (const o of this.added) this.scene.remove(o);
    this.added.length = 0;
  }

  push(obj: THREE.Object3D): void {
    if (!obj.visible) return;
    obj.updateMatrixWorld();
    const clone = new THREE.Object3D();
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(obj.matrixWorld);
    clone.matrixWorld.copy(obj.matrixWorld);
    // obj自身(Mesh)を子として複製せず、元のgeometry/materialを持つMeshを新規に1個だけ作る
    const mesh = obj as THREE.Mesh;
    const clonedMesh = new THREE.Mesh(mesh.geometry, mesh.material);
    clonedMesh.matrixAutoUpdate = false;
    clonedMesh.matrix.copy(obj.matrixWorld);
    clonedMesh.matrixWorld.copy(obj.matrixWorld);
    this.scene.add(clonedMesh);
    this.added.push(clonedMesh);
  }

  endFrame(): void {}
}