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
  readonly radius: number; // [m]
}

const RING_SEGMENTS = 128;
// 帯の見かけ幅がこの px を超えると実寸アニュラスへ完全に切り替わる。未満では省略リングと
// 連続的にブレンドする(幅 0 で省略リングのみ)。
const ANNULUS_FADE_PX = 8;
const ANNULUS_OPACITY = 0.18;
const RING_OPACITY = 0.55;
const PAD_BRIGHTNESS = 0.4;
// 省略リングの半径。天体半径に対する比率 — 「天体を囲う記号」なので実寸の域とは無関係。
const SYMBOLIC_RING_RADIUS_RATIO = 1.25;

let sharedUnitCircle: THREE.BufferGeometry | null = null;

// 半径1・XY平面上の円周ジオメトリを遅延生成して使い回す(省略リング用)。
function unitCircleGeometry(): THREE.BufferGeometry {
  if (sharedUnitCircle !== null) return sharedUnitCircle;
  const positions = new Float32Array(RING_SEGMENTS * 3);
  for (let i = 0; i < RING_SEGMENTS; i++) {
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

// 1枚の占有域が持つ2表現。半径が変わったときだけアニュラスのジオメトリを組み直す。
interface OrbitZoneObjects {
  readonly annulus: THREE.Mesh;
  readonly ring: THREE.LineLoop;
  inner: number;
  outer: number;
}

export class FactionZoneView {
  private readonly orbitZones = new Map<string, OrbitZoneObjects>();
  private readonly pads = new Map<string, Billboard>();

  public sync(
    orbitZones: readonly OrbitZoneVisual[],
    pads: readonly PadZoneVisual[],
    cameraQuat: THREE.Quaternion,
  ): void {
    this.syncOrbitZones(orbitZones);
    this.syncPads(pads, cameraQuat);
  }

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
      // 域の半径は構成員の軌道が変わったときだけ動く — 変化があればジオメトリを組み直す。
      if (objects.inner !== zone.innerRadius || objects.outer !== zone.outerRadius) {
        objects.annulus.geometry.dispose();
        // 円軌道だけの帯は幅 0 で届く — 退化した面にならないよう最小の厚みを与える。
        objects.annulus.geometry = new THREE.RingGeometry(
          zone.innerRadius, Math.max(zone.outerRadius, zone.innerRadius * 1.002), RING_SEGMENTS);
        objects.inner = zone.innerRadius;
        objects.outer = zone.outerRadius;
      }
      objects.annulus.position.copy(zone.position);
      objects.annulus.quaternion.copy(zone.quaternion);
      // ring は annulus の子なので位置・姿勢は親に従う。スケールだけ毎フレーム合わせる。
      objects.ring.scale.setScalar(zone.bodyRadius * SYMBOLIC_RING_RADIUS_RATIO);
      // 見かけ幅で実寸アニュラスと省略リングを連続的に切り替える。
      const fade = Math.min(zone.widthPx / ANNULUS_FADE_PX, 1);
      (objects.annulus.material as THREE.MeshBasicMaterial).opacity = ANNULUS_OPACITY * fade;
      objects.annulus.visible = fade > 0;
      (objects.ring.material as THREE.LineBasicMaterial).opacity = RING_OPACITY * (1 - fade);
      objects.ring.visible = fade < 1;
    }
  }

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
    const ring = new THREE.LineLoop(
      unitCircleGeometry(),
      new THREE.LineBasicMaterial({ color: zone.color, transparent: true, opacity: 0 }),
    );
    markOverlay(ring);
    annulus.add(ring);
    this.scene?.add(annulus);
    return { annulus, ring, inner: zone.innerRadius, outer: zone.outerRadius };
  }

  private dropOrbitZone(key: string): void {
    const objects = this.orbitZones.get(key);
    if (objects === undefined) return;
    objects.annulus.geometry.dispose();
    (objects.annulus.material as THREE.Material).dispose();
    objects.annulus.removeFromParent();
    (objects.ring.material as THREE.Material).dispose();
    this.orbitZones.delete(key);
  }

  private syncPads(pads: readonly PadZoneVisual[], cameraQuat: THREE.Quaternion): void {
    for (const key of this.pads.keys()) {
      if (pads.every((pad) => pad.key !== key)) this.dropPad(key);
    }
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

  // 生成済みの描画物をシーンへ登録する。view はシーンを保持しないので、組んだオブジェクトは
  // ここで拾ってもらう。
  public attach(scene: THREE.Scene): void {
    this.scene = scene;
    for (const objects of this.orbitZones.values()) {
      scene.add(objects.annulus);
    }
    for (const billboard of this.pads.values()) scene.add(billboard.mesh);
  }

  private scene: THREE.Scene | null = null;
}
