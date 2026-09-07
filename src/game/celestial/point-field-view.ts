// 小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・散乱円盤の点群のマップビュー表示。位置は
// point-field.ts の軌道要素から引き、群ごとに1つの InstancedMesh へ書き込む。描画半径と色は
// 群ごとに持つ — 内側(メインベルト 2.5 AU)と外側(カイパーベルト 40 AU)とで見合う見た目が
// 大きく異なる。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../math/vec3';
import { FloatingOrigin } from '../camera/floating-origin';
import { PointElements, PointField, PointFieldGroup, pointPositionAt } from './point-field';

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

  // 群1つぶんの InstancedMesh を、その群の描画半径・色で組む。
  constructor(group: PointFieldGroup) {
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
  }

  // メッシュをシーンへ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  // 表示時刻 t の点の位置を、ラウンドロビンで一部ずつ引き直して置く。starPos はこの星系の恒星の
  // ECI 位置。点は恒星中心のローカル座標に置き、浮動原点との差は mesh の位置が吸う。
  sync(fo: FloatingOrigin, t: number, starPos: Vec3, fixedBrightnessScale: number): void {
    this.mesh.visible = true;
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

  // メッシュを描画対象から外す。
  hide(): void {
    this.mesh.visible = false;
  }

  // メッシュを親から外し、インスタンスバッファと自前の geometry/material を解放する。
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export class PointFieldView {
  // 群ごとの描画。軌道要素と instance buffer は build で確保する。
  private groups: readonly PointFieldGroupView[] = [];

  // field はこの星系に付随する生成済みの点群。
  constructor(private readonly field: PointField) {}

  // 群ごとに描画用の InstancedMesh を組んでシーンへ登録する。
  build(scene: THREE.Scene): void {
    this.groups = this.field.map((group) => new PointFieldGroupView(group));
    for (const group of this.groups) group.build(scene);
  }

  // 表示時刻 t の点の位置を引き直して各インスタンスを置く。starPos はこの星系の恒星の ECI 位置。
  // fixedBrightnessScale は露出の順応を打ち消す倍率で、点の明るさをどこから見ても同じに保つ。
  sync(fo: FloatingOrigin, t: number, starPos: Vec3, fixedBrightnessScale: number): void {
    for (const group of this.groups) group.sync(fo, t, starPos, fixedBrightnessScale);
  }

  // 全群の InstancedMesh を描画対象から外す。
  hide(): void {
    for (const group of this.groups) group.hide();
  }

  // 全群の InstancedMesh を解放する。
  dispose(): void {
    for (const group of this.groups) group.dispose();
  }
}
