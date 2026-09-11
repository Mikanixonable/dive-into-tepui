// 軌道ガイド線の進行方向マーカー。頂点が進行方向を向いた小さな三角形を、画面上で一定の大きさに
// まとめて描く。animate のときは曲線のパラメータ(周期に対する経過時刻の割合)に沿って等速で
// 進める — 軌道上では近点で速く・遠点で遅く動く(SPEC/MAP.md)。
import * as THREE from 'three/webgpu';
import { GuideCurve } from './guide-curve';
import { metersPerPixelFromTanHalfFov, MIN_DEPTH } from '../../../math/projection';
import { InstancedPool } from '../../instanced-pool';
import { FloatingOrigin } from '../../camera/floating-origin';
import type { CameraFrame } from '../../camera/camera-frame';

// 進行方向マーカーの出し方。
export type DirectionMarkerMode = 'none' | 'single' | 'many';

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

// 実時刻から求めたアニメーションの位相 [0,1)。表示時刻で進めると、タイムワープ中にマーカーが
// 飛び、一時停止中に止まる。
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

  // マーカーごとに使い回す一時値。
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
  // cacheCamera が読んだ、このフレームのカメラの値。
  private tanHalfFov = 0;
  private orthoHalfHeight = 0;
  private camNear = 0;
  private viewportHeight = 1;

  // capacity 個までのマーカーを1本のプールで描く。renderOrder は添える線と同じ値を渡す。
  public constructor(scene: THREE.Scene, capacity: number, renderOrder: number) {
    this.pool = new InstancedPool(scene, this.geometry, this.material, capacity, true, renderOrder);
    // 線と同じオーバーレイ層に載せる — 世界パスでは天体に隠れ、線だけが手前に残る。
    this.pool.markAsOverlay();
  }

  // addLoop は beginFrame と endFrame の間で呼ぶ。
  public beginFrame(): void { this.pool.beginFrame(); }
  public endFrame(): void { this.pool.endFrame(); }

  // カメラの画角・位置・描画先の高さをこのフレーム用に読み直す。addLoop の前に1回呼べば足りる。
  public cacheCamera(frame: CameraFrame): void {
    const camera = frame.camera;
    this.viewportHeight = frame.viewport.height;
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    // 透視投影は画角と距離から、平行投影は高さから m/px が決まる。
    if (camera instanceof THREE.PerspectiveCamera) {
      this.tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      this.orthoHalfHeight = 0;
      this.camNear = camera.near;
    } else if (camera instanceof THREE.OrthographicCamera) {
      this.tanHalfFov = 0;
      this.orthoHalfHeight = (camera.top - camera.bottom) * 0.5;
      this.camNear = camera.near;
    } else {
      // それ以外のカメラは画角 50° の透視投影とみなす。
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

  // 'many' モードで並べる個数。周回数に比例させ、1〜MAX_MARKERS_PER_LOOP 個に収める。
  private manyCount(revolutions: number): number {
    const count = Math.round(revolutions * MANY_MARKERS_PER_REVOLUTION);
    return Math.max(1, Math.min(MAX_MARKERS_PER_LOOP, count));
  }

  // 曲線のパラメータ phase(0..1)の位置に、描かれている曲線の接線を進行方向としたマーカーを
  // 1個置く。
  private placeMarker(curve: GuideCurve, phase: number, fo: FloatingOrigin): void {
    // 少し前後の2点から位置と接線を引く。
    const ahead = Math.min(1, phase + TANGENT_PROBE_SPAN);
    const behind = ahead - TANGENT_PROBE_SPAN;
    const w0 = fo.RtoThreeV3(curve.pointAt(behind));
    const w1 = fo.RtoThreeV3(curve.pointAt(ahead));
    this.pos.copy(w0).lerp(w1, (phase - behind) / TANGENT_PROBE_SPAN);
    this.tangent.copy(w1).sub(w0);
    if (this.tangent.lengthSq() < 1e-12) this.tangent.set(0, 0, 1);
    this.tangent.normalize();

    // 接線をカメラ正対の平面へ射影した向きを、画面上の進行方向とする。視線とほぼ平行な区間は
    // 射影が退化するので、billboard の up を使う。
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
      ? (2 * this.orthoHalfHeight) / this.viewportHeight
      : metersPerPixelFromTanHalfFov(this.tanHalfFov, depth, this.viewportHeight);
    return MARKER_HEIGHT_PX * mpp;
  }

  // プールとジオメトリ・マテリアルを解放する。
  public dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
