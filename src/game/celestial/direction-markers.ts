// 軌道ガイド線の進行方向マーカー。頂点が進行方向を向いた小さな正三角形を、InstancedPool で
// まとめて描く。画面上の大きさはズームによらず一定に保ち(scaleAtLocal と同じ考え方で
// カメラからの距離を m/px へ換算する)、animate ON のときは曲線のパラメータ(周期に対する
// 経過時刻の割合)に沿って進める — パラメータが時刻なので、等速で進めるだけで
// 「近点で速く・遠点で遅く」の動きになる。
import * as THREE from 'three/webgpu';
import { GuideCurve } from './guide-curve';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../../math/projection';
import { InstancedPool } from '../../render/instanced-pool';
import { FloatingOrigin } from '../floating-origin';
import type { DirectionMarkerMode } from './orbit-guide-settings';

// 画面上のマーカーの高さ [px](頂点から底辺まで)。
const MARKER_HEIGHT_PX = 10;
// 'many' モードで軌道1周あたりに並べるマーカーの数。
const MANY_MARKERS_PER_REVOLUTION = 6;
// 1本の軌道あたりに置く 'many' マーカー数の上限。
const MAX_MARKERS_PER_LOOP = 12;
// 接線を取るためにパラメータをずらす幅。曲線1本ぶんの長さに対する割合で、小さすぎると
// 差分が f64 の丸めに埋もれ、大きすぎると弦の向きが接線から外れる。
const TANGENT_PROBE_SPAN = 1e-3;

// アニメーションが1周(パラメータ 0→1)にかける実時間 [s]。
const ANIMATION_PERIOD_SEC = 20;

// アニメーションの位相を進める実時刻 [s]。表示時刻(ゲーム内時間)で進めると、タイムワープ中に
// マーカーが飛び、一時停止中に止まってしまう。
function animationPhase(): number {
  return (performance.now() / 1000 / ANIMATION_PERIOD_SEC) % 1;
}

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

  public constructor(scene: THREE.Scene, capacity: number, renderOrder: number) {
    this.pool = new InstancedPool(scene, this.geometry, this.material, capacity, true, renderOrder);
    // マーカーは軌道ガイド線に添えるものなので、線と同じオーバーレイ層に載せる
    // (世界パスに置くと天体に隠れ、線だけが手前に残って見える)。
    this.pool.markAsOverlay();
  }

  public beginFrame(): void { this.pool.beginFrame(); }
  public endFrame(): void { this.pool.endFrame(); }

  // カメラの画角・位置をこのフレーム用に読み直す。addLoop の前に1回呼べば足りる。
  public cacheCamera(camera: THREE.Camera): void {
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

  // 1本の軌道ぶんのマーカーを積む。mode が 'none' なら何もしない。revolutions は曲線1本に
  // 入る周回数で、'many' モードで並べる個数を決める。
  public addLoop(
    curve: GuideCurve, revolutions: number, mode: DirectionMarkerMode, animate: boolean,
    colorHex: number, fo: FloatingOrigin,
  ): void {
    if (mode === 'none') return;
    const offset = animate ? animationPhase() : 0;
    this.color.setHex(colorHex);
    const phases = mode === 'single' ? 1 : this.manyCount(revolutions);
    for (let i = 0; i < phases; i++) {
      const phase = (i / phases + offset) % 1;
      this.placeMarker(curve, phase, fo);
    }
  }

  private manyCount(revolutions: number): number {
    const count = Math.round(revolutions * MANY_MARKERS_PER_REVOLUTION);
    return Math.max(1, Math.min(MAX_MARKERS_PER_LOOP, count));
  }

  // 周期に対する経過時刻の割合 phase(0..1)における位置・進行方向(接線)を、描かれている
  // 曲線から直に引いてマーカーを1個置く。接線は少し先の点との差で取る。
  private placeMarker(curve: GuideCurve, phase: number, fo: FloatingOrigin): void {
    const ahead = Math.min(1, phase + TANGENT_PROBE_SPAN);
    const behind = ahead - TANGENT_PROBE_SPAN;
    const w0 = fo.RtoThreeV3(curve.pointAt(behind));
    const w1 = fo.RtoThreeV3(curve.pointAt(ahead));
    this.pos.copy(w0).lerp(w1, (phase - behind) / TANGENT_PROBE_SPAN);
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

  public dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
