// 同一ジオメトリ/マテリアルを共有する大量の個体を、1本の InstancedMesh でまとめて描画するプール。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markOverlay, markSunShadowCaster } from './pipeline/lit-layer';
import { INSTANCE_THERMAL_ATTRIBUTE, writeThermalState } from './thermal-emissive';
import type { SunShadowExtent } from './pipeline/sun-shadow-casters';

// three は instanceMatrix のバッファ長を最初の描画時に一度だけ確定する。よって count は
// 容量に固定したまま動かさず、未使用の枠はゼロ行列で潰して描画対象から外す。
const PARKED = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

// capacity 体までを1本の InstancedMesh で描く。beginFrame → push(...) → endFrame の順に
// 毎フレーム呼び、その間に push した Object3D の変換をまとめて描画する。
export class InstancedPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private count = 0;
  // 前フレームに使った枠数。今フレームで余った枠だけをゼロ行列へ戻すために持つ。
  private lastCount = 0;
  // 個体1つぶんの外接球半径 [ジオメトリ座標]。AABB を積むとき、インスタンスの位置へこれを
  // スケール倍して広げる。InstancedMesh.computeBoundingBox() は一度計算すると結果を握り
  // 続けるので、毎フレーム動く個体には使えない。
  private readonly instanceRadius: number;
  // 今フレームに push された個体を包む描画座標の AABB。endFrame で公開用の箱へ移す。
  private readonly pending = new THREE.Box3();
  private readonly extent: SunShadowExtent = { worldBounds: new THREE.Box3() };
  // 個体ごとの熱の状態(温度・局所的な過熱・輻射率)。持たないプールでは null。
  private readonly thermal: THREE.InstancedBufferAttribute | null = null;
  // 今フレームに積んだ熱の状態が前フレームと違ったか。同じなら転送し直さない。
  private thermalChanged = false;
  private readonly scratchCenter = new THREE.Vector3();
  private readonly scratchCorner = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    perInstanceColor = false,
    renderOrder = 0,
    perInstanceThermal = false,
  ) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, this.capacity);
    this.mesh.renderOrder = renderOrder;
    // 変換は storage バッファで渡す。既定の属性のままだと、three は容量ぶんの mat4 を
    // uniform 配列として頂点シェーダへ焼き込むので、プールを1本足すたびに巨大な定数配列を
    // 抱えたシェーダが1本増え、起動時のコンパイルがその本数ぶん伸びる。
    this.mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(this.capacity, 16);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (perInstanceColor) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    if (perInstanceThermal) {
      this.thermal = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      this.thermal.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(INSTANCE_THERMAL_ATTRIBUTE, this.thermal);
    }
    // 個体が広い空間へ散らばるため、原点周りの外接球によるフラスタムカリングは意味を持たない。
    this.mesh.frustumCulled = false;
    markLitOpaque(this.mesh);
    markSunShadowCaster(this.mesh);
    this.mesh.userData.sunShadowExtent = this.extent;
    geometry.computeBoundingSphere();
    this.instanceRadius = geometry.boundingSphere?.radius ?? 0;
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, PARKED);
    scene.add(this.mesh);
  }

  // 参照線と同じオーバーレイ層へ載せる。天体に遮られず、トーンマップも通さない見え方になる。
  markAsOverlay(): void {
    markOverlay(this.mesh);
  }

  beginFrame(): void {
    this.count = 0;
    this.pending.makeEmpty();
  }

  // visible な renderObject を capacity まで受け付け、matrixWorld をインスタンスへ転写する。
  // シーン外の Object3D は事前に matrixWorld を同期して渡す。
  push(renderObject: THREE.Object3D, color?: THREE.Color): void {
    if (!renderObject.visible || this.count >= this.capacity) return;
    renderObject.updateMatrixWorld();
    this.mesh.setMatrixAt(this.count, renderObject.matrixWorld);
    if (color && this.mesh.instanceColor) this.mesh.setColorAt(this.count, color);
    if (this.thermal !== null
      && writeThermalState(renderObject, this.thermal.array as Float32Array, this.count * 3)) {
      this.thermalChanged = true;
    }
    const reach = this.instanceRadius * renderObject.matrixWorld.getMaxScaleOnAxis();
    this.scratchCenter.setFromMatrixPosition(renderObject.matrixWorld);
    this.pending.expandByPoint(this.scratchCorner.copy(this.scratchCenter).addScalar(reach));
    this.pending.expandByPoint(this.scratchCorner.copy(this.scratchCenter).addScalar(-reach));
    this.count++;
  }

  // このフレームぶんの転写を締める。余った枠を潰し、公開する広がりを今フレームの値へ入れ替える。
  endFrame(): void {
    for (let i = this.count; i < this.lastCount; i++) this.mesh.setMatrixAt(i, PARKED);
    this.lastCount = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (this.thermal !== null && this.thermalChanged) {
      this.thermal.needsUpdate = true;
      this.thermalChanged = false;
    }
    this.extent.worldBounds.copy(this.pending);
  }

  // InstancedMesh をシーンから外し、そのインスタンスバッファを解放する。geometry/material は
  // 呼び出し側から渡された共有資源なので、その所有者だけが破棄できる。
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
