// 小惑星帯・トロヤ群の点群のマップビュー表示。位置は asteroid-belt.ts の軌道要素から引き、
// 1つの InstancedMesh の instanceMatrix へ書き込む。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { Vec3, add, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import {
  AsteroidElements, allAsteroids, asteroidPositionAt, generateAsteroidBelt,
} from './asteroid-belt';

// 1点の描画半径 [m]。マップのズーム域では点として見える大きさ。
const ASTEROID_DRAW_RADIUS = 3e7;
const ASTEROID_COLOR = 0x777777;
// 1フレームで位置を引き直す点の割合の逆数。小惑星の公転は最速でも4年強なので、
// マップのズーム域では数フレーム遅れた位置と現在位置は1画素も違わない。
const UPDATE_FRACTION = 4;

export class AsteroidField {
  private readonly elements: readonly AsteroidElements[];
  // 太陽中心の位置。ECI 化に要る太陽位置は毎フレーム変わるので、ここには太陽中心のまま持つ。
  private readonly positions: Vec3[];
  private readonly mesh: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  // ラウンドロビン更新で次に引き直す点の添字。
  private cursor = 0;
  private sunPos: Vec3 = v3(0, 0, 0);
  // 初回の update だけは全点を評価する — ラウンドロビンに任せると、マップを開いた直後の
  // 数フレームは未評価の点(太陽中心の零ベクトル)が太陽位置に固まって描かれる。
  private primed = false;

  // 点群を生成し、描画用の InstancedMesh を組む。
  constructor() {
    this.elements = allAsteroids(generateAsteroidBelt());
    this.positions = this.elements.map(() => v3(0, 0, 0));
    // 正四面体を使うのは、全インスタンスが同じ姿勢で並ぶため — 平板だと視線方向によっては
    // 点群全体が同時に消える。
    const geom = new THREE.TetrahedronGeometry(ASTEROID_DRAW_RADIUS);
    const mat = new THREE.MeshBasicMaterial({ color: ASTEROID_COLOR, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geom, mat, this.elements.length);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  // 点群をシーンへ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  // 表示時刻 t の点の位置を引き直す。広範囲視点でないときは何もしない — 戦闘視点では
  // 描かれないので位置を求める意味がない。
  update(t: number, overviewMode: boolean, ephemeris: Ephemeris): void {
    if (!overviewMode) return;
    this.sunPos = ephemeris.positionOf('sun', t);
    const n = this.elements.length;
    const count = this.primed ? Math.ceil(n / UPDATE_FRACTION) : n;
    this.primed = true;
    for (let i = 0; i < count; i++) {
      const idx = (this.cursor + i) % n;
      this.positions[idx] = asteroidPositionAt(this.elements[idx]!, t);
    }
    this.cursor = (this.cursor + count) % n;
  }

  // update が求めた位置へ各インスタンスを置く。浮動原点は毎フレーム動くので、位置を引き直して
  // いない点も含めて全インスタンスの行列を書き直す。
  sync(fo: FloatingOrigin, overviewMode: boolean): void {
    this.mesh.visible = overviewMode;
    if (!overviewMode) return;
    for (let i = 0; i < this.positions.length; i++) {
      const p = fo.RtoThreeV3(add(this.positions[i]!, this.sunPos));
      this.matrix.makeTranslation(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
