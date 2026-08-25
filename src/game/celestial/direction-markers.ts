// 軌道ガイド線の進行方向マーカー。頂点が進行方向を向いた小さな正三角形を、InstancedPool で
// まとめて描く。画面上の大きさはズームによらず一定に保ち(scaleAtLocal と同じ考え方で
// カメラからの距離を m/px へ換算する)、animate ON のときは GuideLoop.times(周期に対する
// 経過時刻の割合)に沿って進める — 元の点列が弧長等間隔である一方 times は実際の軌道速度で
// 進むぶんが不均等なので、時刻の等速内挿がそのまま「近点で速く・遠点で遅く」の動きになる。
import * as THREE from 'three/webgpu';
import { GuideLoop } from '../../physics/orbit-guide';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../../physics/projection';
import { InstancedPool } from '../../render/instanced-pool';
import { FloatingOrigin } from '../floating-origin';
import type { DirectionMarkerMode } from './orbit-guide-settings';

// 画面上のマーカーの高さ [px](頂点から底辺まで)。
const MARKER_HEIGHT_PX = 10;
// 'many' モードの間隔の目安([点列の点数] / この値 が配置数になる)。族の焼き込み点数
// (96点、orbit-catalog 参照)を基準に、軌道1周に4〜8個程度並ぶ値を選んだ。
const MANY_MARKER_STRIDE = 16;
// 1本の軌道あたりに置く 'many' マーカー数の上限。
const MAX_MARKERS_PER_LOOP = 12;
// アニメーションが1周(t: 0→1)にかける実時間 [s]。この値そのものに物理的意味は無く、
// 「近点で速く・遠点で遅く」という相対関係だけが times の内挿から出る。
const ANIMATION_PERIOD_SEC = 20;

// マーカー1個ぶんの三角形ジオメトリ(単位サイズ、+Y が進行方向)。
function buildTriangleGeometry(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array([
    0, 1, 0,
    -0.6, -0.6, 0,
    0.6, -0.6, 0,
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex([0, 1, 2]);
  return geom;
}

export class DirectionMarkers {
  private readonly pool: InstancedPool;
  private readonly geometry = buildTriangleGeometry();
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
  });

  // 使い回すスクラッチ(毎フレーム多数呼ばれるため確保を避ける)。
  private readonly dummy = new THREE.Object3D();
  private readonly pos = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly markerUp = new THREE.Vector3();
  private readonly markerRight = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private readonly camPos = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private tanHalfFov = 0;
  private orthoHalfHeight = 0;
  private camNear = 0;

  constructor(scene: THREE.Scene, capacity: number, renderOrder: number) {
    this.pool = new InstancedPool(scene, this.geometry, this.material, capacity, true, renderOrder);
  }

  beginFrame(): void { this.pool.beginFrame(); }
  endFrame(): void { this.pool.endFrame(); }

  // カメラの画角・位置をこのフレーム用に読み直す。addLoop の前に1回呼べば足りる。
  cacheCamera(camera: THREE.Camera): void {
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    if (camera instanceof THREE.PerspectiveCamera) {
      this.tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      this.orthoHalfHeight = 0;
      this.camNear = camera.near;
    } else if (camera instanceof THREE.OrthographicCamera) {
      this.tanHalfFov = 0;
      this.orthoHalfHeight = (camera.top - camera.bottom) * 0.5;
      this.camNear = camera.near;
    } else {
      this.tanHalfFov = Math.tan((50 * Math.PI) / 360);
      this.orthoHalfHeight = 0;
      this.camNear = MIN_DEPTH;
    }
  }

  // 1本の軌道ぶんのマーカーを積む。mode が 'none' か点列が短すぎるなら何もしない。
  addLoop(
    loop: GuideLoop, mode: DirectionMarkerMode, animate: boolean, simTime: number,
    colorHex: number, fo: FloatingOrigin,
  ): void {
    if (mode === 'none' || loop.points.length < 2 || loop.times.length !== loop.points.length) return;
    const offset = animate ? ((simTime / ANIMATION_PERIOD_SEC) % 1 + 1) % 1 : 0;
    this.color.setHex(colorHex);
    const phases = mode === 'single' ? 1 : this.manyCount(loop.points.length);
    for (let i = 0; i < phases; i++) {
      const phase = (i / phases + offset) % 1;
      this.placeMarker(loop, phase, fo);
    }
  }

  private manyCount(pointCount: number): number {
    return Math.max(1, Math.min(MAX_MARKERS_PER_LOOP, Math.floor(pointCount / MANY_MARKER_STRIDE)));
  }

  // 周期に対する経過時刻の割合 phase(0..1)における位置・進行方向(接線)を、隣り合う
  // 焼き込み点2つの内挿から求めてマーカーを1個置く。
  private placeMarker(loop: GuideLoop, phase: number, fo: FloatingOrigin): void {
    const { points, times, closed } = loop;
    const n = points.length;
    // times は単調増加(0始まり)。phase 以下の最大の添字を二分探索する。
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((times[mid] ?? 0) <= phase) lo = mid; else hi = mid - 1;
    }
    const i = lo;
    const j = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const t0 = times[i] ?? 0;
    const t1 = j === 0 && closed ? 1 : (times[j] ?? 1);
    const span = t1 - t0;
    const f = span > 1e-9 ? Math.max(0, Math.min(1, (phase - t0) / span)) : 0;
    const p0 = points[i]!, p1 = points[j]!;

    const w0 = fo.RtoThreeV3(p0);
    const w1 = fo.RtoThreeV3(p1);
    this.pos.copy(w0).lerp(w1, f);
    this.tangent.copy(w1).sub(w0);
    if (this.tangent.lengthSq() < 1e-12) this.tangent.set(0, 0, 1);
    this.tangent.normalize();

    // カメラに正対する平面(normal)上へ接線を射影し、その向きを画面上の「進行方向」とする
    // (velocity-aligned billboard)。ほぼ視線と平行な区間では射影がほぼ0になるので、
    // その場合は billboard の up をそのまま向きに使う(退化を避けるだけで、意味は無い)。
    this.normal.copy(this.camPos).sub(this.pos).normalize();
    this.right.crossVectors(this.worldUp, this.normal);
    if (this.right.lengthSq() < 1e-9) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(this.normal, this.right);

    const tx = this.tangent.dot(this.right);
    const ty = this.tangent.dot(this.up);
    if (tx * tx + ty * ty < 1e-9) {
      this.markerUp.copy(this.up);
    } else {
      this.markerUp.copy(this.right).multiplyScalar(tx).addScaledVector(this.up, ty).normalize();
    }
    this.markerRight.crossVectors(this.markerUp, this.normal).normalize();

    this.basis.makeBasis(this.markerRight, this.markerUp, this.normal);
    this.dummy.quaternion.setFromRotationMatrix(this.basis);
    this.dummy.position.copy(this.pos);
    this.dummy.scale.setScalar(this.screenConstantScale());
    this.dummy.updateMatrix();
    this.pool.push(this.dummy, this.color);
  }

  // 現在のマーカー位置(this.pos)における、画面上 MARKER_HEIGHT_PX を保つための実距離スケール。
  private screenConstantScale(): number {
    const depth = Math.max(this.camNear, this.pos.distanceTo(this.camPos));
    const mpp = this.orthoHalfHeight > 0
      ? (2 * this.orthoHalfHeight) / window.innerHeight
      : metersPerPixelFromTanHalfFov(this.tanHalfFov, depth, window.innerHeight);
    return MARKER_HEIGHT_PX * mpp;
  }

  dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
