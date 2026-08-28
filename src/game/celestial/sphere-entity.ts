// 「テクスチャ球」で済む天体(月・木星など)の見た目を実 ECI 位置・実半径で描く。
// 見かけ直径が閾値未満なら球自体を描かない。
import * as THREE from 'three/webgpu';
import { CelestialMotion, OrbitingMotion } from '../../physics/celestial-motion';
import { RingSystemDef, shapeAxes } from '../../physics/solar-system/celestial-body-def';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { showsPhysicalSphere } from '../../render/screen-lod';
import { CelestialSurface } from '../../render/celestial-surface';
import { BodyGraticule } from '../../render/body-graticule';
import type { LineOverlay } from '../../render/line-overlay';
import { CelestialEntity } from './celestial-entity';
import type { BodyClass } from './body-class';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { SunLight } from '../../render/pipeline/sun-light';
import type { SunOcclusion } from '../../render/pipeline/sun-occlusion';
import type { RenderStyle } from '../../render/render-style';
import { RingView } from './ring-view';

export class SphereEntity extends CelestialEntity {
  private readonly group = new THREE.Group();
  // 実半径 [m] と環(環を持たない天体では undefined)。
  private readonly radius: number;
  private readonly rings?: RingSystemDef;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;
  // 環を含めた最外半径 [m]。radius だけで見かけ直径を判定すると、本体が閾値未満でも
  // 環がまだ画面に見える大きさのまま球体ごと隠してしまう。
  private readonly outerRadius: number;
  private ring?: RingView;
  // 模式図スタイルでだけ見せる経緯度グリッド。姿勢は group の子として自然に追従する。
  private readonly graticule = new BodyGraticule();
  // 模式図スタイルでだけ見せる、天体固有の表面ライン(月の海・クレーターなど)。持たない天体では
  // undefined のまま。
  private readonly surfaceMarkings?: LineOverlay;

  // 実半径・歪みの形状・環は motion の定義から引く。surfaceMarkings は表面ラインの LineOverlay を
  // 作るファクトリ(その天体固有のデータを持つ具象クラスを呼び出し側が渡す)。
  constructor(
    motion: OrbitingMotion,
    name: string,
    bodyClass: BodyClass,
    private readonly surface: CelestialSurface,
    surfaceMarkings?: () => LineOverlay,
  ) {
    super(motion, name, bodyClass);
    const def = motion.def;
    this.radius = def.radius;
    this.rings = def.rings;
    const a = shapeAxes(def.radius, def.shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
    this.outerRadius = def.rings === undefined
      ? def.radius
      : def.rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), def.radius);
    this.surfaceMarkings = surfaceMarkings?.();
  }

  // 表面メッシュと環をシーンへ一度だけ登録する。
  build(scene: THREE.Scene, sunOcclusion: SunOcclusion, sunLight: SunLight): void {
    this.surface.addTo(this.group);
    this.graticule.addTo(this.group);
    this.surfaceMarkings?.addTo(this.group);
    scene.add(this.group);
    if (this.rings !== undefined) {
      this.ring = new RingView(
        this.rings, this.radius, this.group.renderOrder + 1, sunOcclusion, sunLight,
      );
      scene.add(this.ring.group);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (this.ring !== undefined) this.ring.group.visible = visible;
  }

  // displayTime 時点の位置へ同期する。見かけ直径が閾値未満なら球自体(と環)を描かない。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, _star: CelestialMotion | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.group.visible) return;
    const pos = this.motion.stateAt(displayTime).r;
    const apparentDiameterPx = this.lodApparentDiameterPx(
      2 * this.outerRadius, cameraSystem.activeCameraScale(pos), graphics);
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      return;
    }
    this.surface.syncLod(apparentDiameterPx);
    this.graticule.setVisible(style === 'schematic');
    this.surfaceMarkings?.setVisible(style === 'schematic');
    this.group.position.copy(fo.RtoThreeV3(pos));
    // 歪んだ天体は3軸それぞれの半軸を使う。環へ渡すのは一様スケール(赤道半径)の方で、
    // 扁平は乗せない。
    this.group.scale.copy(this.axes);
    // モデル座標は +Y が自転軸、+Z が本初子午線。同期回転する天体はこれで親を向き続ける。
    const orientation = this.motion.orientationAt(displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    const rings = graphics.rings ? this.rings : undefined;
    if (this.ring !== undefined && rings !== undefined) {
      this.ring.group.visible = true;
      this.ring.sync(
        this.group.position,
        orientation === null ? null : orientation.axis,
        pos,
        cameraSystem.activeCameraScale,
        style,
      );
    } else if (this.ring !== undefined) {
      this.ring.group.visible = false;
    }
  }

  // 見かけ直径が閾値未満のときの共通後始末: 表面と環を隠す。
  private hidePhysical(): void {
    this.surface.hide();
    this.graticule.setVisible(false);
    this.surfaceMarkings?.setVisible(false);
    if (this.ring !== undefined) this.ring.group.visible = false;
  }

  // 表面とグリッドと表面ラインと環を解放し、group を親から外す。
  dispose(): void {
    this.group.removeFromParent();
    this.surface.dispose();
    this.graticule.dispose();
    this.surfaceMarkings?.dispose();
    this.ring?.dispose();
  }
}
