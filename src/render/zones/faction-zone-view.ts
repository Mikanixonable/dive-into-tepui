// 勢力の占有域の描画物。天体まわりの帯(実寸アニュラス⇔省略リング)とラグランジュ点の
// パッドを持ち、域の宣言(OrbitZoneVisual / PadZoneVisual)へ毎フレーム同期する。
import * as THREE from 'three/webgpu';
import { markOverlay } from '../pipeline/lit-layer';
import { Billboard } from '../billboard';

// 天体まわりの占有域1枚の描画宣言。位置・姿勢は描画座標系(フローティング原点適用済み)の値。
export interface OrbitZoneVisual {
  readonly key: string; // 域の一意キー(天体 id + 勢力)。フレームを跨いで同じ域に同じ値を渡す
  readonly color: string;
  readonly innerRadius: number; // [m]
  readonly outerRadius: number; // [m]
  readonly position: THREE.Vector3; // 中心天体の描画座標
  readonly quaternion: THREE.Quaternion; // 赤道面の姿勢
  readonly bodyRadius: number; // [m] — 省略リングの半径の基準
  readonly widthPx: number; // 帯の実幅の見かけ幅 [px] — 実寸⇔省略の切替に使う
}

// ラグランジュ点の占有パッド1枚の描画宣言。
export interface PadZoneVisual {
  readonly key: string;
  readonly color: string;
  readonly position: THREE.Vector3;
  readonly radius: number; // 描画上の表示半径 [m](画面サイズ由来。占有判定の論理半径ではない)
}

const RING_SEGMENTS = 128;
// 見かけ幅に応じて実寸表示へ切り替える境目 [px]。
const ANNULUS_FADE_PX = 8;
const ANNULUS_OPACITY = 0.18;
const RING_OPACITY = 0.55;
const PAD_BRIGHTNESS = 0.4;
// 記号リングを天体の周囲に置く半径比。
const SYMBOLIC_RING_RADIUS_RATIO = 1.25;

let sharedUnitCircle: THREE.BufferGeometry | null = null;

// 省略リングに使う単位円の輪郭を返す。
function unitCircleGeometry(): THREE.BufferGeometry {
  if (sharedUnitCircle !== null) return sharedUnitCircle;
  // 呼び出し側の表示倍率に合わせて拡大する輪郭を共用する。WebGPU の描画は LineLoop を描かないので、
  // 始点を終点にも置いて折れ線で閉じる。
  const positions = new Float32Array((RING_SEGMENTS + 1) * 3);
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    positions[i * 3] = Math.cos(a);
    positions[i * 3 + 1] = Math.sin(a);
    positions[i * 3 + 2] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  sharedUnitCircle = geo;
  return geo;
}

// 帯の頂点を内外の半径 [m] へ書き直す。頂点の並びと値は RingGeometry(innerRadius, outerRadius,
// RING_SEGMENTS) と同じ。頂点数が変わらないので、作り直さずに書き換えて送る。
function writeAnnulusRadii(geometry: THREE.BufferGeometry, innerRadius: number, outerRadius: number): void {
  const positions = geometry.getAttribute('position');
  let radius = innerRadius;
  for (let ring = 0; ring <= 1; ring++) {
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const segment = i / RING_SEGMENTS * (Math.PI * 2);
      positions.setXY(ring * (RING_SEGMENTS + 1) + i, radius * Math.cos(segment), radius * Math.sin(segment));
    }
    radius += outerRadius - innerRadius;
  }
  positions.needsUpdate = true;
  geometry.computeBoundingSphere();
}

// 実寸アニュラスと記号リングを組み合わせた軌道域の表示物。
interface OrbitZoneObjects {
  readonly annulus: THREE.Mesh;
  readonly ring: THREE.Line;
  inner: number;
  outer: number;
}

export class FactionZoneView {
  private readonly orbitZones = new Map<string, OrbitZoneObjects>();
  private readonly pads = new Map<string, Billboard>();

  // 軌道帯と点パッドの表示状態を宣言へ揃える。
  public sync(
    orbitZones: readonly OrbitZoneVisual[],
    pads: readonly PadZoneVisual[],
    cameraQuat: THREE.Quaternion,
  ): void {
    this.syncOrbitZones(orbitZones);
    this.syncPads(pads, cameraQuat);
  }

  // 宣言された軌道域を描画へ反映する。
  private syncOrbitZones(zones: readonly OrbitZoneVisual[]): void {
    for (const key of this.orbitZones.keys()) {
      if (zones.every((zone) => zone.key !== key)) this.dropOrbitZone(key);
    }
    for (const zone of zones) {
      let objects = this.orbitZones.get(zone.key);
      if (objects === undefined) {
        objects = this.createOrbitZone(zone);
        this.orbitZones.set(zone.key, objects);
      }
      if (objects.inner !== zone.innerRadius || objects.outer !== zone.outerRadius) {
        // 円軌道だけの帯は幅 0 で届く — 退化した面にならないよう最小の厚みを与える。
        writeAnnulusRadii(
          objects.annulus.geometry, zone.innerRadius, Math.max(zone.outerRadius, zone.innerRadius * 1.002));
        objects.inner = zone.innerRadius;
        objects.outer = zone.outerRadius;
      }
      objects.annulus.position.copy(zone.position);
      objects.annulus.quaternion.copy(zone.quaternion);
      objects.ring.scale.setScalar(zone.bodyRadius * SYMBOLIC_RING_RADIUS_RATIO);
      const fade = Math.min(zone.widthPx / ANNULUS_FADE_PX, 1);
      (objects.annulus.material as THREE.MeshBasicMaterial).opacity = ANNULUS_OPACITY * fade;
      objects.annulus.visible = fade > 0;
      (objects.ring.material as THREE.LineBasicMaterial).opacity = RING_OPACITY * (1 - fade);
      objects.ring.visible = fade < 1;
    }
  }

  // 実寸の帯と、天体を囲む記号リングを組んだ表示物を返す。
  private createOrbitZone(zone: OrbitZoneVisual): OrbitZoneObjects {
    const annulus = new THREE.Mesh(
      new THREE.RingGeometry(
        zone.innerRadius, Math.max(zone.outerRadius, zone.innerRadius * 1.002), RING_SEGMENTS),
      new THREE.MeshBasicMaterial({
        color: zone.color, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    markOverlay(annulus);
    annulus.renderOrder = -1;
    // 画面上で細くなる帯の占有先を記号リングで示す。
    const ring = new THREE.Line(
      unitCircleGeometry(),
      new THREE.LineBasicMaterial({ color: zone.color, transparent: true, opacity: 0 }),
    );
    markOverlay(ring);
    annulus.add(ring);
    this.scene?.add(annulus);
    return { annulus, ring, inner: zone.innerRadius, outer: zone.outerRadius };
  }

  // 軌道帯の専有ジオメトリとマテリアルを解放する。
  private dropOrbitZone(key: string): void {
    const objects = this.orbitZones.get(key);
    if (objects === undefined) return;
    objects.annulus.geometry.dispose();
    (objects.annulus.material as THREE.Material).dispose();
    objects.annulus.removeFromParent();
    (objects.ring.material as THREE.Material).dispose();
    this.orbitZones.delete(key);
  }

  // 宣言された点パッドを描画状態へ反映する。
  private syncPads(pads: readonly PadZoneVisual[], cameraQuat: THREE.Quaternion): void {
    // 表示時刻で消えた占有パッドを片付ける。
    for (const key of this.pads.keys()) {
      if (pads.every((pad) => pad.key !== key)) this.dropPad(key);
    }
    // 現在の占有位置とカメラへ合わせてパッドを表示する。
    for (const pad of pads) {
      let billboard = this.pads.get(pad.key);
      if (billboard === undefined) {
        billboard = new Billboard(pad.color, -1);
        this.scene?.add(billboard.mesh);
        this.pads.set(pad.key, billboard);
      }
      billboard.sync(pad.position, pad.radius * 2, PAD_BRIGHTNESS, cameraQuat);
    }
  }

  // 点パッドの表示資源を解放する。
  private dropPad(key: string): void {
    const billboard = this.pads.get(key);
    if (billboard === undefined) return;
    billboard.mesh.removeFromParent();
    billboard.dispose();
    this.pads.delete(key);
  }

  // 全オブジェクトを解放する。
  public dispose(): void {
    for (const key of this.orbitZones.keys()) this.dropOrbitZone(key);
    for (const key of this.pads.keys()) this.dropPad(key);
  }

  // 描画物を指定されたシーンへ登録する。
  public attach(scene: THREE.Scene): void {
    this.scene = scene;
    for (const objects of this.orbitZones.values()) {
      scene.add(objects.annulus);
    }
    for (const billboard of this.pads.values()) scene.add(billboard.mesh);
  }

  private scene: THREE.Scene | null = null;
}
