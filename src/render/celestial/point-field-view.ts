// 小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・散乱円盤の点群のマップビュー表示。群ごとの
// 表示契約(描画半径・色)を定め、軌道要素から引いた位置を群ごとに1つの InstancedMesh へ置く。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../math/vec3';
import { PointElements, pointPositionAt } from '../../physics/point-orbit';
import { FloatingOrigin } from '../camera/floating-origin';

// 表示する点群1群。drawRadius と color は群ごとの見た目で、内側の群と外側の群とでは
// 見合う大きさ・色が一桁変わるため群ごとに持つ。
export interface PointFieldGroup {
  readonly id: string;
  readonly points: readonly PointElements[];
  readonly drawRadius: number; // [m]
  readonly color: number;
}

export type PointField = readonly PointFieldGroup[];

// 1フレームで位置を引き直す点の割合の逆数。外側の群ほど公転が遅いので、マップのズーム域では
// 数フレーム遅れた位置と現在位置は1画素も違わない。
const UPDATE_FRACTION = 8;

// 群1つぶんの InstancedMesh と、そこへ書き込む位置のラウンドロビン更新を持つ。
class PointFieldGroupView {
  private readonly points: readonly PointElements[];
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  // 順応を打ち消す倍率を掛ける前の色。
  private readonly baseColor: THREE.Color;
  private readonly matrix = new THREE.Matrix4();
  // ラウンドロビンで次に引き直す点の先頭。
  private cursor = 0;
  // 初回の sync で全点を評価済みか。ラウンドロビンに任せると、マップを開いた直後の数フレームは
  // 未評価の点(零ベクトル)が太陽位置に固まって描かれる。
  private primed = false;

  // 群1つぶんの InstancedMesh を、その群の描画半径・色で組んでシーンへ登録する。
  public constructor(group: PointFieldGroup, scene: THREE.Scene) {
    this.points = group.points;
    // 正四面体を使うのは、全インスタンスが同じ姿勢で並ぶため — 平板だと視線方向によっては
    // 群全体が同時に消える。
    const geom = new THREE.TetrahedronGeometry(group.drawRadius);
    this.material = new THREE.MeshBasicMaterial({ color: group.color, depthWrite: false });
    this.baseColor = new THREE.Color(group.color);
    this.mesh = new THREE.InstancedMesh(geom, this.material, this.points.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 個体が群の軌道全域(main-belt〜kuiper-belt は AU スケール)へ散らばるため、
    // 原点周りの外接球によるフラスタムカリングは意味を持たない。
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // 表示時刻 t の点の位置を、ラウンドロビンで一部ずつ引き直して置く。starPos は点を置く恒星の
  // ECI 位置で、置かないフレームでは null。点は恒星中心のローカル座標に置き、浮動原点との差は
  // mesh の位置が吸う。
  public sync(
    fo: FloatingOrigin, t: number, starPos: Vec3 | null, fixedBrightnessScale: number,
  ): void {
    this.mesh.visible = starPos !== null;
    if (starPos === null) return;
    this.material.color.copy(this.baseColor).multiplyScalar(fixedBrightnessScale);
    this.mesh.position.copy(fo.RtoThreeV3(starPos));
    // このフレームの持ち分を引き直す。
    const n = this.points.length;
    const count = this.primed ? Math.ceil(n / UPDATE_FRACTION) : n;
    this.primed = true;
    for (let i = 0; i < count; i++) {
      const idx = (this.cursor + i) % n;
      const p = pointPositionAt(this.points[idx]!, t);
      this.matrix.makeTranslation(p.x, p.y, p.z);
      this.mesh.setMatrixAt(idx, this.matrix);
    }
    this.cursor = (this.cursor + count) % n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // メッシュを親から外し、インスタンスバッファと自前の geometry/material を解放する。
  public dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export class PointFieldView {
  // 点群を置くシーン。build を受けるまでは持たない。
  private scene: THREE.Scene | null = null;
  // 群ごとの描画。最初に点を見せるフレームまでは null。
  private groups: readonly PointFieldGroupView[] | null = null;

  // field はこの星系に付随する生成済みの点群。
  public constructor(private readonly field: PointField) {}

  // 点群を置くシーンを受け取る。実際の資源は、最初に点を見せるフレームまで確保しない。
  public build(scene: THREE.Scene): void {
    this.scene = scene;
  }

  // 表示可否と、そのフレームの値を反映する。starPos はこの星系の恒星の ECI 位置で、引けない
  // フレームは点を置けない。fixedBrightnessScale は露出の順応を打ち消す倍率で、点の明るさを
  // どこから見ても同じに保つ。
  public sync(
    visible: boolean, fo: FloatingOrigin, t: number, starPos: Vec3 | null,
    fixedBrightnessScale: number,
  ): void {
    // このフレームに点を置く恒星の位置。置かないフレームは null。
    const placeAt = visible ? starPos : null;
    // InstancedMesh の確保は、点を最初に見せるフレームまで遅らせる — 点群を切った設定や
    // マップを開かないランで、起動時に確保の負荷を負うのを避けるため。
    if (this.groups === null) {
      const scene = this.scene;
      if (placeAt === null || scene === null) return;
      this.groups = this.field.map((group) => new PointFieldGroupView(group, scene));
    }
    for (const group of this.groups) group.sync(fo, t, placeAt, fixedBrightnessScale);
  }

  // 確保済みの InstancedMesh を解放する。
  public dispose(): void {
    if (this.groups === null) return;
    for (const group of this.groups) group.dispose();
  }
}
