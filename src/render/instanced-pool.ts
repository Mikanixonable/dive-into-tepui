// 同一ジオメトリ/マテリアルを共有する大量の個体を、1本の InstancedMesh でまとめて描画するプール。
import * as THREE from 'three/webgpu';

// three の InstanceNode は instanceMatrix の受け渡し方を InstancedMesh.count から決め、
// その判断とバッファ長を最初の描画時に一度だけ確定する。よって count は容量に固定した
// まま動かさず、未使用の枠はゼロ行列で潰して描画対象から外す。
const PARKED = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

// capacity 体までを1本の InstancedMesh で描く。beginFrame → push(...) → endFrame の順に
// 毎フレーム呼び、その間に push した Object3D の変換をまとめて描画する。
export class InstancedPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private count = 0;
  // 前フレームに使った枠数。今フレームで余った枠だけをゼロ行列へ戻すために持つ。
  private lastCount = 0;

  constructor(scene: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, perInstanceColor = false, renderOrder = 0) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.renderOrder = renderOrder;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (perInstanceColor) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    // 個体が広い空間へ散らばるため、原点周りの外接球によるフラスタムカリングは意味を持たない。
    this.mesh.frustumCulled = false;
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, PARKED);
    scene.add(this.mesh);
  }

  beginFrame(): void {
    this.count = 0;
  }

  // obj が非表示なら何もしない。容量を超えた分は描画されない。matrixWorld を使うので、
  // シーン外の Object3D(あるいはその子)を渡す側は事前に updateMatrixWorld() を呼んでおく。
  push(obj: THREE.Object3D, color?: THREE.Color): void {
    if (!obj.visible || this.count >= this.capacity) return;
    obj.updateMatrixWorld();
    this.mesh.setMatrixAt(this.count, obj.matrixWorld);
    if (color && this.mesh.instanceColor) this.mesh.setColorAt(this.count, color);
    this.count++;
  }

  endFrame(): void {
    for (let i = this.count; i < this.lastCount; i++) this.mesh.setMatrixAt(i, PARKED);
    this.lastCount = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
