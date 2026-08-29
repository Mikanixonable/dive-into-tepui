// 小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・散乱円盤の点群のマップビュー表示。位置は
// point-field.ts の軌道要素から引き、群ごとに1つの InstancedMesh の instanceMatrix へ書き込む。
// 群を分けるのは、内側(メインベルト 2.5 AU)と外側(カイパーベルト 40 AU)とで見合う描画半径・色が
// 大きく異なるため — 群ごとの見た目は表示専用のこの層だけが持ち、point-field.ts の分布定義は
// THREE 非依存に保つ。
import * as THREE from 'three/webgpu';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { Vec3, v3 } from '../../../math/vec3';
import { FloatingOrigin } from '../../camera/floating-origin';
import {
  PointElements, PointFieldGroup, generatePointField, pointPositionAt,
} from './point-field';

// 群ごとの描画半径 [m] と色。カイパーベルト・散乱円盤はメインベルト・トロヤ群/ヒルダ群より
// 一桁遠いので、同じ描画半径では見えなくなる分だけ大きくしてある。
const GROUP_VIEW: Readonly<Record<string, { readonly drawRadius: number; readonly color: number }>> = {
  'main-belt': { drawRadius: 3e7, color: 0x777777 },
  'trojan-l4': { drawRadius: 3e7, color: 0x777777 },
  'trojan-l5': { drawRadius: 3e7, color: 0x777777 },
  hilda: { drawRadius: 3e7, color: 0x777777 },
  'kuiper-cold': { drawRadius: 1.2e8, color: 0x5588aa },
  'kuiper-hot': { drawRadius: 1.2e8, color: 0x5588aa },
  'scattered-disk': { drawRadius: 1.2e8, color: 0xaa8855 },
};
const FALLBACK_VIEW = { drawRadius: 3e7, color: 0x777777 };

// 1フレームで位置を引き直す点の割合の逆数。外側の群ほど公転が遅いので、マップのズーム域では
// 数フレーム遅れた位置と現在位置は1画素も違わない。点数がメインベルト+トロヤ群単体の頃の倍に
// 増えた分、値も倍にしてある。
const UPDATE_FRACTION = 8;

// 群1つぶんの InstancedMesh と、そこへ書き込む位置のラウンドロビン更新を持つ。
class PointFieldGroupView {
  private readonly points: readonly PointElements[];
  // 太陽中心の位置。ECI 化に要る太陽位置は毎フレーム変わるので、ここには太陽中心のまま持つ。
  private readonly positions: Vec3[];
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  // 順応を打ち消す前の色。sync がこれへ倍率を掛けて材質色を書く。
  private readonly baseColor: THREE.Color;
  private readonly matrix = new THREE.Matrix4();
  // update で位置を再評価したインスタンスだけを sync で GPU へ書き戻す。
  // 配列は毎フレーム作り直さず、clear 後も容量を再利用する。
  private readonly dirtyIndices: number[] = [];
  private cursor = 0;
  private sunPos: Vec3 = v3(0, 0, 0);
  // 初回の update だけは全点を評価する — ラウンドロビンに任せると、マップを開いた直後の
  // 数フレームは未評価の点(太陽中心の零ベクトル)が太陽位置に固まって描かれる。
  private primed = false;

  // 群1つぶんの InstancedMesh を、その群の描画半径・色で組む。
  constructor(group: PointFieldGroup) {
    this.points = group.points;
    this.positions = this.points.map(() => v3(0, 0, 0));
    const view = GROUP_VIEW[group.id] ?? FALLBACK_VIEW;
    // 正四面体を使うのは、全インスタンスが同じ姿勢で並ぶため — 平板だと視線方向によっては
    // 群全体が同時に消える。
    const geom = new THREE.TetrahedronGeometry(view.drawRadius);
    this.material = new THREE.MeshBasicMaterial({ color: view.color, depthWrite: false });
    this.baseColor = new THREE.Color(view.color);
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

  // 表示時刻 t の点の位置を、ラウンドロビンで一部だけ引き直す。sunPos は呼び出し元が
  // 群をまたいで1回だけ求めた値を渡す。forceAll はマップ再入場時に使う。
  update(t: number, sunPos: Vec3, forceAll = false): void {
    this.sunPos = sunPos;
    const n = this.points.length;
    if (forceAll) this.dirtyIndices.length = 0;
    const count = forceAll || !this.primed ? n : Math.ceil(n / UPDATE_FRACTION);
    this.primed = true;
    for (let i = 0; i < count; i++) {
      const idx = (this.cursor + i) % n;
      this.positions[idx] = pointPositionAt(this.points[idx]!, t);
      this.dirtyIndices.push(idx);
    }
    this.cursor = (this.cursor + count) % n;
  }

  // update が求めた位置へ、再評価されたインスタンスだけを置く。点群の太陽中心からの位置は
  // InstancedMesh のローカル座標に残し、太陽の ECI 位置と FloatingOrigin の差分は mesh の
  // 親位置へ移す。これにより浮動原点が毎フレーム変わっても全インスタンスを更新せずに済む。
  sync(fo: FloatingOrigin, visible: boolean, fixedBrightnessScale: number): void {
    this.mesh.visible = visible;
    if (!visible) return;
    this.material.color.copy(this.baseColor).multiplyScalar(fixedBrightnessScale);
    this.mesh.position.copy(fo.RtoThreeV3(this.sunPos));
    for (const idx of this.dirtyIndices) {
      const p = this.positions[idx]!;
      this.matrix.makeTranslation(p.x, p.y, p.z);
      this.mesh.setMatrixAt(idx, this.matrix);
    }
    if (this.dirtyIndices.length > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirtyIndices.length = 0;
    }
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
  // 現在の星系に恒星が実在するか。無ければ点群は太陽中心の座標を持てないので非表示にする。
  private hasStar = true;
  // update は map の表示中だけ呼ばれるため、false から true へ戻るフレームを再入場とみなす。
  private mapActive = false;

  // 点群を生成し、群ごとに描画用の InstancedMesh を組んでシーンへ登録する。
  build(scene: THREE.Scene): void {
    this.groups = generatePointField().map((group) => new PointFieldGroupView(group));
    for (const group of this.groups) group.build(scene);
  }

  // 表示時刻 t の点の位置を引き直す。star はこの星系の恒星の運動で、恒星を持たない星系では
  // null。広範囲視点でないときは何もしない — 戦闘視点では描かれないので位置を求める意味がない。
  update(t: number, overviewMode: boolean, star: CelestialMotion | null): void {
    this.hasStar = star !== null;
    if (!overviewMode || star === null) {
      this.mapActive = false;
      return;
    }
    const sunPos = star.stateAt(t).r;
    const reentered = !this.mapActive;
    this.mapActive = true;
    for (const group of this.groups) group.update(t, sunPos, reentered);
  }

  // update が求めた位置へ各インスタンスを置く。太陽の平行移動は mesh.position、個々の点の
  // 更新は instanceMatrix に分担させる。fixedBrightnessScale は露出の順応を打ち消す倍率で、
  // 読ませるために選んだ明るさをどこから見ても同じに保つ。
  sync(fo: FloatingOrigin, overviewMode: boolean, smallBodyVisible: boolean, fixedBrightnessScale: number): void {
    const visible = overviewMode && this.hasStar && smallBodyVisible;
    for (const group of this.groups) group.sync(fo, visible, fixedBrightnessScale);
  }

  // 全群の InstancedMesh を解放する。
  dispose(): void {
    for (const group of this.groups) group.dispose();
  }
}
