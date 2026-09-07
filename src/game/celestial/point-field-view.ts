// 小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・散乱円盤の点群のマップビュー表示。位置は
// point-field.ts の軌道要素から引き、群ごとに1つの InstancedMesh の instanceMatrix へ書き込む。
// 群を分けるのは、内側(メインベルト 2.5 AU)と外側(カイパーベルト 40 AU)とで見合う描画半径・色が
// 大きく異なるため — 群ごとの見た目は表示専用のこの層だけが持ち、point-field.ts の分布定義は
// THREE 非依存に保つ。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../math/vec3';
import { FloatingOrigin } from '../camera/floating-origin';
import { PointElements, PointField, PointFieldGroup, pointPositionAt } from './point-field';

// 1フレームで位置を引き直す点の割合の逆数。外側の群ほど公転が遅いので、マップのズーム域では
// 数フレーム遅れた位置と現在位置は1画素も違わない。点数がメインベルト+トロヤ群単体の頃の倍に
// 増えた分、値も倍にしてある。
const UPDATE_FRACTION = 8;

// 群1つぶんの InstancedMesh と、そこへ書き込む位置のラウンドロビン更新を持つ。
class PointFieldGroupView {
  private readonly points: readonly PointElements[];
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  // 順応を打ち消す前の色。sync がこれへ倍率を掛けて材質色を書く。
  private readonly baseColor: THREE.Color;
  private readonly matrix = new THREE.Matrix4();
  // ラウンドロビンで次に引き直す点の先頭。
  private cursor = 0;
  // 初回の sync だけは全点を評価する — ラウンドロビンに任せると、マップを開いた直後の
  // 数フレームは未評価の点(太陽中心の零ベクトル)が太陽位置に固まって描かれる。
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

  // 表示時刻 t の点の位置を、ラウンドロビンで一部だけ引き直して置く。starPos はこの星系の
  // 恒星の ECI 位置で、呼び出し元が群をまたいで1回だけ求めた値を渡す。点群の太陽中心からの
  // 位置は InstancedMesh のローカル座標に残し、恒星の ECI 位置と FloatingOrigin の差分は
  // mesh の親位置へ移す。これにより浮動原点が毎フレーム変わっても全インスタンスを更新せずに済む。
  sync(fo: FloatingOrigin, t: number, starPos: Vec3, fixedBrightnessScale: number): void {
    this.mesh.visible = true;
    this.material.color.copy(this.baseColor).multiplyScalar(fixedBrightnessScale);
    this.mesh.position.copy(fo.RtoThreeV3(starPos));
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
  // 群ごとの描画。**11,200点の軌道要素と instance buffer は build まで確保しない** —
  // マップを一度も開かないプレイでは要らないため。
  private groups: readonly PointFieldGroupView[] = [];

  // field はこの星系に付随する生成済みの点群。どんな分布から作られたかはここでは問わない。
  constructor(private readonly field: PointField) {}

  // 群ごとに描画用の InstancedMesh を組んでシーンへ登録する。
  build(scene: THREE.Scene): void {
    this.groups = this.field.map((group) => new PointFieldGroupView(group));
    for (const group of this.groups) group.build(scene);
  }

  // 表示時刻 t の点の位置を引き直して各インスタンスを置く。starPos はこの星系の恒星の ECI 位置。
  // 恒星の平行移動は mesh.position、個々の点の更新は instanceMatrix に分担させる。
  // fixedBrightnessScale は露出の順応を打ち消す倍率で、読ませるために選んだ明るさをどこから
  // 見ても同じに保つ。
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
