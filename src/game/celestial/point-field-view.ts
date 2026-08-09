// 小惑星帯・トロヤ群・ヒルダ群・カイパーベルト・散乱円盤の点群のマップビュー表示。位置は
// point-field.ts の軌道要素から引き、群ごとに1つの InstancedMesh の instanceMatrix へ書き込む。
// 群を分けるのは、内側(メインベルト 2.5 AU)と外側(カイパーベルト 40 AU)とで見合う描画半径・色が
// 大きく異なるため — 群ごとの見た目は表示専用のこの層だけが持ち、point-field.ts の分布定義は
// THREE 非依存に保つ。
// game-entity/asteroid.ts の Asteroid(重力を及ぼし積分される個別の GameEntity)とは別物。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { Vec3, add, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import {
  PointElements, PointField, PointFieldGroup, generatePointField, pointPositionAt,
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
  private readonly matrix = new THREE.Matrix4();
  private cursor = 0;
  private sunPos: Vec3 = v3(0, 0, 0);
  // 初回の update だけは全点を評価する — ラウンドロビンに任せると、マップを開いた直後の
  // 数フレームは未評価の点(太陽中心の零ベクトル)が太陽位置に固まって描かれる。
  private primed = false;

  constructor(group: PointFieldGroup) {
    this.points = group.points;
    this.positions = this.points.map(() => v3(0, 0, 0));
    const view = GROUP_VIEW[group.id] ?? FALLBACK_VIEW;
    // 正四面体を使うのは、全インスタンスが同じ姿勢で並ぶため — 平板だと視線方向によっては
    // 群全体が同時に消える。
    const geom = new THREE.TetrahedronGeometry(view.drawRadius);
    const mat = new THREE.MeshBasicMaterial({ color: view.color, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geom, mat, this.points.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  build(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  update(t: number, sunPos: Vec3): void {
    this.sunPos = sunPos;
    const n = this.points.length;
    const count = this.primed ? Math.ceil(n / UPDATE_FRACTION) : n;
    this.primed = true;
    for (let i = 0; i < count; i++) {
      const idx = (this.cursor + i) % n;
      this.positions[idx] = pointPositionAt(this.points[idx]!, t);
    }
    this.cursor = (this.cursor + count) % n;
  }

  sync(fo: FloatingOrigin, visible: boolean): void {
    this.mesh.visible = visible;
    if (!visible) return;
    for (let i = 0; i < this.positions.length; i++) {
      const p = fo.RtoThreeV3(add(this.positions[i]!, this.sunPos));
      this.matrix.makeTranslation(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class PointFieldView {
  private readonly groups: readonly PointFieldGroupView[];
  // 現在のレジストリに恒星が実在するか。無ければ点群は太陽中心の座標を持てないので非表示にする。
  private hasStar = true;

  // 点群を生成し、群ごとに描画用の InstancedMesh を組む。
  constructor(field: PointField = generatePointField()) {
    this.groups = field.map((group) => new PointFieldGroupView(group));
  }

  // 点群をシーンへ登録する。
  build(scene: THREE.Scene): void {
    for (const group of this.groups) group.build(scene);
  }

  // 表示時刻 t の点の位置を引き直す。広範囲視点でないときは何もしない — 戦闘視点では
  // 描かれないので位置を求める意味がない。
  update(t: number, overviewMode: boolean, ephemeris: Ephemeris): void {
    this.hasStar = ephemeris.starId !== null;
    if (!overviewMode || ephemeris.starId === null) return;
    const sunPos = ephemeris.positionOf(ephemeris.starId, t);
    for (const group of this.groups) group.update(t, sunPos);
  }

  // update が求めた位置へ各インスタンスを置く。浮動原点は毎フレーム動くので、位置を引き直して
  // いない点も含めて全インスタンスの行列を書き直す。
  sync(fo: FloatingOrigin, overviewMode: boolean): void {
    const visible = overviewMode && this.hasStar;
    for (const group of this.groups) group.sync(fo, visible);
  }
}
