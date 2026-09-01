// 同期軌道(自転と同じ周期で公転する赤道円軌道)の高度を示す、マップ専用のリングとラベル。
// 実在の衛星や特定経度ではなく、高度の目盛りとして引く1本。
import * as THREE from 'three/webgpu';
import { CelestialMotion } from '../../../physics/celestial-motion';
import { OrbitalElements, orbitalElementsFromClassical } from '../../../physics/elements';
import { isOccluded } from '../../../physics/occlusion';
import { add, len, scale, sub, type Vec3 } from '../../../math/vec3';
import { LINE_RENDER_ORDER } from '../../../render/line-style';
import { CameraSystem } from '../../camera/camera-system';
import { FloatingOrigin } from '../../camera/floating-origin';
import * as C from '../../const';
import { EllipseLine } from '../../lines/ellipse-line';
import type { MarkerManager } from '../../marker/marker-manager';

// リングとラベルは中心天体から 240,000km で薄れ始め 720,000km で消える。
const FADE_NEAR_DIST = 2.4e8;
const FADE_SPAN = 4.8e8;

// ラベルはリングよりやや濃く残して視認性を保つ。
const LABEL_OPACITY = 0.90;
const RING_OPACITY = 0.55;

// ラベルを置く軌道上の位相。
const LABEL_ANOMALY = Math.PI / 4;

const MARKER_KEY = 'geolabel';

// 真円に近い離心率。厳密な 0 は軌道面基底が縮退するので避ける。
const NEAR_CIRCULAR_E = 1e-6;

// 高度 [m] を「35,786km」の形の表示へ整える。
function altitudeLabel(altitude: number): string {
  const km = Math.round(altitude / 1000).toString();
  return `GEO (${km.replace(/\B(?=(\d{3})+$)/g, ',')}km)`;
}

export class GeostationaryOverlay {
  private readonly line = new EllipseLine(
    { color: 0x8b93a0, opacity: 0.2, renderOrder: LINE_RENDER_ORDER.reference });
  // 同期軌道の長半径 [m] と、その高度を書いたラベル。
  private readonly semiMajorAxis: number;
  private readonly label: string;

  // semiMajorAxis [m] は of() が表面より外にあることを確かめた同期軌道の長半径。
  private constructor(motion: CelestialMotion, semiMajorAxis: number) {
    this.semiMajorAxis = semiMajorAxis;
    this.label = altitudeLabel(semiMajorAxis - motion.def.radius);
  }

  // 天体の重力定数と自転周期から同期軌道を解く。自転モデルを持たない天体、あるいは解が
  // 表面より内側になる天体では同期軌道が引けないので null。
  static of(motion: CelestialMotion): GeostationaryOverlay | null {
    const spinRate = motion.spinRate;
    if (spinRate === null || spinRate === 0) return null;
    const period = Math.abs((2 * Math.PI) / spinRate);
    const a = Math.cbrt((motion.def.mu * period * period) / (4 * Math.PI * Math.PI));
    if (!(a > motion.def.radius)) return null;
    return new GeostationaryOverlay(motion, a);
  }

  // リングをシーンへ一度だけ登録する。ラベルは MarkerManager が持つので登録は要らない。
  build(scene: THREE.Scene): void {
    scene.add(this.line.line);
  }

  // リングとラベルをこのフレームの表示状態へ同期する。visible は所有者の判断
  // (マップ視点 かつ 同期軌道トグル ON)。
  sync(
    center: CelestialMotion, pivot: number, fo: FloatingOrigin, cameraSystem: CameraSystem,
    markerManager: MarkerManager | null, celestialBodies: readonly CelestialMotion[], visible: boolean,
  ): void {
    const centerPos = center.positionAt(pivot);
    const elements = this.elementsAround(center, pivot);
    this.line.sync(visible ? elements : null, fo, cameraSystem.activeCamera);
    const dist = len(sub(centerPos, cameraSystem.activeCameraPos));
    const fade = 1.0 - Math.min(1, Math.max(0, (dist - FADE_NEAR_DIST) / FADE_SPAN));
    if (visible) this.line.setOpacity(RING_OPACITY * fade);
    this.syncLabel(
      elements, centerPos, pivot, fade, cameraSystem, markerManager, celestialBodies, visible);
  }

  // リングを親から外して解放する。
  dispose(): void {
    this.line.line.removeFromParent();
    this.line.dispose();
  }

  // 時刻 pivot の中心天体位置に置いた赤道面上の円軌道。
  private elementsAround(center: CelestialMotion, pivot: number): OrbitalElements {
    return orbitalElementsFromClassical(
      this.semiMajorAxis, NEAR_CIRCULAR_E, 0, 0, 0, center, center.stateAt(pivot));
  }

  // 軌道上の1点へ、高度を書いた半透明の小さな文字ラベルを置く。
  private syncLabel(
    elements: OrbitalElements, centerPos: Vec3, pivot: number, fade: number,
    cameraSystem: CameraSystem, markerManager: MarkerManager | null,
    celestialBodies: readonly CelestialMotion[], visible: boolean,
  ): void {
    if (markerManager === null) return;
    // 消えるほど薄いラベルは、射影も遮蔽判定もせずに畳む。
    const opacity = LABEL_OPACITY * fade;
    if (!visible || opacity <= 0.02) {
      markerManager.hide(MARKER_KEY);
      return;
    }
    const r = this.semiMajorAxis;
    const pos = add(centerPos, add(
      scale(elements.pHat, r * Math.cos(LABEL_ANOMALY)), scale(elements.qHat, r * Math.sin(LABEL_ANOMALY))));
    const cameraPos = cameraSystem.activeCameraPos;
    const p = cameraSystem.activeCameraProjection(pos);
    if (!p.front || isOccluded(cameraPos, pos, celestialBodies, pivot)) {
      markerManager.hide(MARKER_KEY);
      return;
    }
    markerManager.set(
      MARKER_KEY, 'mk-geolabel', this.label, p.x, p.y, p.front, '', opacity,
      undefined, undefined, false, true, C.MARKER_PRIORITY.ORBITAL_NODE, len(sub(pos, cameraPos)));
  }
}
