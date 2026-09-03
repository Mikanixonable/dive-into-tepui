// 選択中ノードの Δv アーム6本(PRO/RET・NRM/ANM・OUT/IN)を表す 3D 矢印ギズモ。ノード位置へ
// 置いて軌道基準枠へ向け、ドラッグ中の1本を伸ばして見せる。
import * as THREE from 'three/webgpu';
import { qFromBasis } from '../../math/quat';
import { Vec3 } from '../../math/vec3';
import { AXIS_PROGRADE, AXIS_NORMAL, AXIS_RADIAL } from '../../theme';
import { markOverlay } from '../../render/pipeline/lit-layer';
import type { AxisHandleDrag } from './node-gizmo';

const APPARENT_SIZE_PER_MAP_DIST = 0.002; // マップカメラ距離 1 あたりのスケール(見かけの大きさを一定に保つ)

// 矢印1本の寸法(group のローカル単位。画面上の大きさは APPARENT_SIZE_PER_MAP_DIST で決まる)
const ARROW_LENGTH = 20; // 素の全長
const ARROW_HEAD_LENGTH = 4; // 先端の円錐の長さ
const ARROW_HEAD_WIDTH = 2.5; // 先端の円錐の底面半径
const ARROW_STEM_WIDTH = 0.5; // 軸の円柱の半径
const ARROW_OPACITY = 0.8;

const DRAG_STRETCH = 0.2; // ラッチ前のドラッグ中に矢印を伸ばす割合
const LATCH_STRETCH_PER_PX = 0.01; // ラッチ超過 1px あたりの伸び
const LATCH_STRETCH_MAX = 0.5; // ラッチで伸ばす割合の上限

// 矢印1本ぶんのメッシュ。dir は group のローカル座標での向き(単位ベクトル)。
interface ArrowPart {
  readonly stem: THREE.Mesh;
  readonly head: THREE.Mesh;
  readonly dir: THREE.Vector3;
}

export class PlanGizmo3D {
  public readonly group = new THREE.Group();
  // 6本の矢印。index は axis*2 + (sign<0 ? 1 : 0)。
  private readonly parts: ArrowPart[] = [];

  // 6本の矢印を組み、非表示で始める。ローカル軸は X=RAD, Y=PRO, Z=NRM。
  public constructor() {
    this.createAxis(new THREE.Vector3(0, 1, 0), AXIS_PROGRADE); // PRO
    this.createAxis(new THREE.Vector3(0, -1, 0), AXIS_PROGRADE); // RET
    this.createAxis(new THREE.Vector3(0, 0, 1), AXIS_NORMAL); // NRM
    this.createAxis(new THREE.Vector3(0, 0, -1), AXIS_NORMAL); // ANM
    this.createAxis(new THREE.Vector3(1, 0, 0), AXIS_RADIAL); // OUT
    this.createAxis(new THREE.Vector3(-1, 0, 0), AXIS_RADIAL); // IN

    this.group.visible = false;
  }

  // ローカル方向 dir(単位ベクトル)を向く矢印(軸+頭)を1本作り、group へ加える。
  private createAxis(dir: THREE.Vector3, color: string): void {
    const stemLength = ARROW_LENGTH - ARROW_HEAD_LENGTH;
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: ARROW_OPACITY });

    const stemGeom = new THREE.CylinderGeometry(ARROW_STEM_WIDTH, ARROW_STEM_WIDTH, stemLength, 8);
    const stem = new THREE.Mesh(stemGeom, material);
    stem.position.copy(dir).multiplyScalar(stemLength / 2);

    const headGeom = new THREE.ConeGeometry(ARROW_HEAD_WIDTH, ARROW_HEAD_LENGTH, 12);
    const head = new THREE.Mesh(headGeom, material);
    head.position.copy(dir).multiplyScalar(ARROW_LENGTH - ARROW_HEAD_LENGTH / 2);

    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    stem.quaternion.copy(quaternion);
    head.quaternion.copy(quaternion);

    // ギズモは表示値であって物理的な明るさを持たないので、3D UI パスへ置く。深度テストは
    // 効かせたまま — 不透明物には隠れるのが 3D UI の約束。
    markOverlay(stem);
    markOverlay(head);
    this.group.add(stem);
    this.group.add(head);
    this.parts.push({ stem, head, dir });
  }

  // ギズモ全体の表示/非表示。
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
    const activeIdx = drag === null ? null : drag.axis * 2 + (drag.sign < 0 ? 1 : 0);
    this.parts.forEach((part, idx) => {
      const length = ARROW_LENGTH * (idx === activeIdx ? 1 + stretch : 1);
      const stemLength = length - ARROW_HEAD_LENGTH;
      part.stem.scale.y = stemLength / (ARROW_LENGTH - ARROW_HEAD_LENGTH);
      part.stem.position.copy(part.dir).multiplyScalar(stemLength / 2);
      part.head.position.copy(part.dir).multiplyScalar(length - ARROW_HEAD_LENGTH / 2);
    });
  }
}
