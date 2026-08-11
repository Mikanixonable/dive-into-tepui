// 同一ジオメトリ/マテリアルを共有する大量の個体を InstancedMesh で描画するプール。
import * as THREE from 'three/webgpu';

// WebGPU の uniform buffer binding サイズはベースライン仕様で 65536 バイト(64KiB)までしか
// 保証されない。three.js の WebGPU バックエンドは instanceMatrix をこの uniform buffer へ
// 詰めるため、1 本の InstancedMesh に積める mat4(64 バイト/個)はこの上限で頭打ちになる。
// これを超えると BindGroup 作成自体が失敗し、以後そのフレームの描画が丸ごと欠落する。
const BYTES_PER_MAT4 = 64;
const MAX_UNIFORM_BUFFER_BINDING_SIZE = 65536;
const MAX_INSTANCES_PER_CHUNK = Math.floor(MAX_UNIFORM_BUFFER_BINDING_SIZE / BYTES_PER_MAT4);

// capacity 体分を、1 本あたり最大 MAX_INSTANCES_PER_CHUNK 体の InstancedMesh 複数本(チャンク)
// に分けて構築し、全チャンクを scene へ追加する。beginFrame → push(...) → endFrame の順に
// 毎フレーム呼び、その間に push した Object3D の変換をまとめて描画する。呼び出し側からは
// 単一プールとして扱え、チャンク分割は内部に閉じている。
export class InstancedPool {
  private readonly chunks: THREE.InstancedMesh[] = [];
  private readonly capacity: number;
  private count = 0;

  constructor(scene: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number) {
    this.capacity = capacity;
    for (let remaining = capacity; remaining > 0; remaining -= MAX_INSTANCES_PER_CHUNK) {
      const chunkCapacity = Math.min(remaining, MAX_INSTANCES_PER_CHUNK);
      const mesh = new THREE.InstancedMesh(geometry, material, chunkCapacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // 個体が広い空間へ散らばるため、原点周りの外接球によるフラスタムカリングは意味を持たない。
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.chunks.push(mesh);
    }
  }

  beginFrame(): void {
    this.count = 0;
  }

  // obj が非表示なら何もしない。容量を超えた分は描画されない。matrixWorld を使うので、
  // シーン外の Object3D(あるいはその子)を渡す側は事前に updateMatrixWorld() を呼んでおく。
  push(obj: THREE.Object3D): void {
    if (!obj.visible || this.count >= this.capacity) return;
    obj.updateMatrixWorld();
    const chunkIndex = Math.floor(this.count / MAX_INSTANCES_PER_CHUNK);
    const indexInChunk = this.count % MAX_INSTANCES_PER_CHUNK;
    const chunk = this.chunks[chunkIndex];
    if (chunk) chunk.setMatrixAt(indexInChunk, obj.matrixWorld);
    this.count++;
  }

  endFrame(): void {
    let remaining = this.count;
    for (const mesh of this.chunks) {
      const used = Math.min(remaining, MAX_INSTANCES_PER_CHUNK);
      mesh.count = used;
      if (used > 0) mesh.instanceMatrix.needsUpdate = true;
      remaining -= used;
    }
  }
}
