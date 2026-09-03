import * as THREE from 'three/webgpu';
import { qFromBasis } from '../../math/quat';
import { Vec3 } from '../../math/vec3';
import { AXIS_PROGRADE, AXIS_NORMAL, AXIS_RADIAL } from '../../theme';
import { markOverlay } from '../../render/pipeline/lit-layer';
import type { AxisHandleDrag } from './node-gizmo';

const APPARENT_SIZE_PER_MAP_DIST = 0.002; // マップカメラ距離 1 あたりのスケール(見かけの大きさを一定に保つ)

const DRAG_STRETCH = 0.2; // ラッチ前のドラッグ中に矢印を伸ばす割合
const LATCH_STRETCH_PER_PX = 0.01; // ラッチ超過 1px あたりの伸び
const LATCH_STRETCH_MAX = 0.5; // ラッチで伸ばす割合の上限

// 選択中ノードの Δv アーム6本(PRO/RET・NRM/ANM・OUT/IN)を表す3D矢印ギズモ。
export class PlanGizmo3D {
  public readonly group = new THREE.Group();
  private parts: { stem: THREE.Mesh, head: THREE.Mesh, dir: THREE.Vector3, baseLen: number }[] = [];

  constructor() {
    this.createAxis(new THREE.Vector3(0, 1, 0), AXIS_PROGRADE); // PRO
    this.createAxis(new THREE.Vector3(0, -1, 0), AXIS_PROGRADE); // RETRO
    this.createAxis(new THREE.Vector3(0, 0, 1), AXIS_NORMAL); // NRM
    this.createAxis(new THREE.Vector3(0, 0, -1), AXIS_NORMAL); // ANTI-NRM
    this.createAxis(new THREE.Vector3(1, 0, 0), AXIS_RADIAL); // RAD
    this.createAxis(new THREE.Vector3(-1, 0, 0), AXIS_RADIAL); // RAD-IN

    this.group.visible = false;
  }

  // ローカル方向 dir(単位ベクトル)を向く矢印(軸+頭)を1本作り、group へ加える。
  private createAxis(dir: THREE.Vector3, color: string): void {
    const length = 20;
    const headLength = 4;
    const headWidth = 2.5;
    const stemLength = length - headLength;
    const stemWidth = 0.5;

    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8
    });

    const stemGeom = new THREE.CylinderGeometry(stemWidth, stemWidth, stemLength, 8);
    const stem = new THREE.Mesh(stemGeom, material);
    stem.position.copy(dir).multiplyScalar(stemLength / 2);

    const headGeom = new THREE.ConeGeometry(headWidth, headLength, 12);
    const head = new THREE.Mesh(headGeom, material);
    head.position.copy(dir).multiplyScalar(length - headLength / 2);

    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    stem.quaternion.copy(quaternion);
    head.quaternion.copy(quaternion);

    // ギズモは表示値であって物理的な明るさを持たないので、3D UI パスへ置く。深度テストは
    // 効かせたまま — 不透明物には隠れるのが 3D UI の約束。
    markOverlay(stem);
    markOverlay(head);
    this.group.add(stem);
    this.group.add(head);
    this.parts.push({ stem, head, dir, baseLen: length });
  }

  public setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  // group をシーンから外し、6本の矢印のジオメトリ・マテリアルを解放する。
  public dispose(): void {
    this.group.removeFromParent();
    for (const part of this.parts) {
      part.stem.geometry.dispose();
      part.head.geometry.dispose();
      (part.stem.material as THREE.Material).dispose();
    }
  }

  // ギズモをノード位置へ置き、ローカル軸(X=RAD, Y=PRO, Z=NRM)を軌道基準系 pro/nrm/rad に揃える。
  // mapDist はマップカメラの距離で、見かけの大きさが距離によらず一定になるようスケールを決める。
  public setPositionAndRotation(pos: THREE.Vector3, pro: Vec3, nrm: Vec3, mapDist: number): void {
    this.group.position.copy(pos);

    // qFromBasis(nrm, pro) の列は (pro×nrm, pro, nrm) = (RAD, PRO, NRM)。
    const q = qFromBasis(nrm, pro);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.group.scale.setScalar(mapDist * APPARENT_SIZE_PER_MAP_DIST);
  }

  // ドラッグ中の Δv アームに当たる矢印を伸ばし、残りは素の長さへ戻す。drag が null なら全本を戻す。
  public setActiveDrag(drag: AxisHandleDrag | null): void {
    // ラッチ前は固定の割合、ラッチ後は超過量に比例させて上限で止める
    const stretch = drag === null ? 0
      : drag.excessPx === null ? DRAG_STRETCH
      : Math.min(drag.excessPx * LATCH_STRETCH_PER_PX, LATCH_STRETCH_MAX);
    for (let i = 0; i < 3; i++) {
      for (const s of [1, -1] as const) {
        const part = this.parts[i * 2 + (s < 0 ? 1 : 0)]!;
        const isActive = drag !== null && i === drag.axis && s === drag.sign;
        const length = part.baseLen * (isActive ? 1 + stretch : 1);
        const headLength = 4;
        const stemLength = length - headLength;
        part.stem.scale.y = stemLength / (part.baseLen - headLength);
        part.stem.position.copy(part.dir).multiplyScalar(stemLength / 2);
        part.head.position.copy(part.dir).multiplyScalar(length - headLength / 2);
      }
    }
  }
}
