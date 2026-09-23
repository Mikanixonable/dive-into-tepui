// 同一ジオメトリ/マテリアルを共有する大量の個体を、1本の InstancedMesh でまとめて描画するプール。
import * as THREE from 'three/webgpu';
import { markLitOpaque, markOverlay, markShadowCaster } from './pipeline/lit-layer';
import { INSTANCE_THERMAL_ATTRIBUTE, writeThermalState } from './thermal-emissive';
import type { ShadowExtent } from './pipeline/shadow/shadow-casters';

// 空き枠へ置くゼロ行列。three は instanceMatrix のバッファ長を最初の描画で確定するので、
// count は容量のまま固定し、空きスロットはこれで無効化（ゼロスケール）する。
const PARKED = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

// capacity 体までを1本の InstancedMesh で描く。beginFrame → push(...) → endFrame の順に
// 毎フレーム呼び、その間に push した Object3D の変換をまとめて描画する。
export class InstancedPool {
  private readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private count = 0;
  // 前フレームに使った枠数。今フレームで余った枠だけをゼロ行列へ戻すために持つ。
  private lastCount = 0;
  // 個体1つぶんの外接球半径 [ジオメトリ座標]。AABB は毎フレームこれで積み直す —
  // InstancedMesh.computeBoundingBox() は最初の結果を握り続ける。
  private readonly instanceRadius: number;
  // 今フレームに push された個体を包む描画座標の AABB。
  private readonly pending = new THREE.Box3();
  // 影を落とす広がりとして公開する AABB。endFrame で pending から移す。
  private readonly extent: ShadowExtent = { worldBounds: new THREE.Box3() };
  // 個体ごとの熱の状態(温度・局所的な過熱・輻射率)。持たないプールでは null。
  private readonly thermal: THREE.InstancedBufferAttribute | null = null;
  // 色・熱は実際にCPU側の配列を書き換えた範囲だけをGPUへ送る。matrix は push した先頭 count 枠と、
  // 個体数が減ったときに PARKED へ戻す末尾だけが dirty になる。
  private colorDirtyEnd = 0;
  private thermalDirtyStart = Infinity;
  private thermalDirtyEnd = 0;
  private readonly scratchCenter = new THREE.Vector3();
  private readonly scratchCorner = new THREE.Vector3();

  // capacity 体ぶんの枠を確保して scene へ登録する。geometry/material は外部から提供される
  // 共有資源で、perInstanceThermal なら geometry へ熱の状態の属性を足す。
  public constructor(
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
    // 変換は storage バッファで渡す。既定の属性だと容量ぶんの mat4 が uniform 配列として
    // シェーダへ焼き込まれ、プールごとに起動時のコンパイルが伸びる。
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
    // ジオメトリの外接球は散らばった個体を包まないので、フラスタム判定を切る。
    this.mesh.frustumCulled = false;
    markLitOpaque(this.mesh);
    markShadowCaster(this.mesh);
    this.mesh.userData.shadowExtent = this.extent;
    geometry.computeBoundingSphere();
    this.instanceRadius = geometry.boundingSphere?.radius ?? 0;
    for (let i = 0; i < this.capacity; i++) this.mesh.setMatrixAt(i, PARKED);
    scene.add(this.mesh);
  }

  // 3D UI のオーバーレイ層へ載せ直す。
  public markAsOverlay(): void {
    markOverlay(this.mesh);
  }

  // このフレームぶんを積み始める。
  public beginFrame(): void {
    this.count = 0;
    this.colorDirtyEnd = 0;
    this.thermalDirtyStart = Infinity;
    this.thermalDirtyEnd = 0;
    this.pending.makeEmpty();
  }

  // visible な renderObject を capacity を上限として受け付け、その変換・色・熱の状態をインスタンスバッファへ
  // コピーする。renderObject の matrixWorld は内部で更新するが、親の matrixWorld は更新済みであることを前提とする。
  public push(renderObject: THREE.Object3D, color?: THREE.Color): void {
    if (!renderObject.visible || this.count >= this.capacity) return;
    renderObject.updateMatrixWorld();
    const index = this.count;
    this.mesh.setMatrixAt(index, renderObject.matrixWorld);
    if (color && this.mesh.instanceColor) {
      this.mesh.setColorAt(index, color);
      this.colorDirtyEnd = index + 1;
    }
    if (this.thermal !== null
      && writeThermalState(renderObject, this.thermal.array as Float32Array, index * 3)) {
      this.thermalDirtyStart = Math.min(this.thermalDirtyStart, index);
      this.thermalDirtyEnd = index + 1;
    }
    // 個体の外接球をスケール倍し、今フレームの AABB へ積む。
    const reach = this.instanceRadius * renderObject.matrixWorld.getMaxScaleOnAxis();
    this.scratchCenter.setFromMatrixPosition(renderObject.matrixWorld);
    this.pending.expandByPoint(this.scratchCorner.copy(this.scratchCenter).addScalar(reach));
    this.pending.expandByPoint(this.scratchCorner.copy(this.scratchCenter).addScalar(-reach));
    this.count++;
  }

  // このフレームぶんの転写を締める。余った枠を潰し、公開する広がりを今フレームの値へ入れ替える。
  public endFrame(): void {
    for (let i = this.count; i < this.lastCount; i++) this.mesh.setMatrixAt(i, PARKED);

    // update range は「要素」ではなく属性配列の component 数で指定する。push は先頭から count 枠を
    // 毎フレーム上書きし、縮んだときだけ [count,lastCount) を PARKED にするので、両者を包む1区間で足りる。
    const matrixDirtyInstances = Math.max(this.count, this.lastCount);
    if (matrixDirtyInstances > 0) {
      const matrix = this.mesh.instanceMatrix;
      matrix.clearUpdateRanges();
      matrix.addUpdateRange(0, matrixDirtyInstances * matrix.itemSize);
      matrix.needsUpdate = true;
    }

    const color = this.mesh.instanceColor;
    if (color !== null && this.colorDirtyEnd > 0) {
      color.clearUpdateRanges();
      color.addUpdateRange(0, this.colorDirtyEnd * color.itemSize);
      color.needsUpdate = true;
    }

    if (this.thermal !== null && this.thermalDirtyEnd > this.thermalDirtyStart) {
      this.thermal.clearUpdateRanges();
      this.thermal.addUpdateRange(
        this.thermalDirtyStart * this.thermal.itemSize,
        (this.thermalDirtyEnd - this.thermalDirtyStart) * this.thermal.itemSize,
      );
      this.thermal.needsUpdate = true;
    }

    this.lastCount = this.count;
    this.extent.worldBounds.copy(this.pending);
  }

  // InstancedMesh をシーンから外し、そのインスタンスバッファを解放する。geometry/material は
  // 外部から渡された共有資源のため、本クラスでは破棄しない。
  public dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
