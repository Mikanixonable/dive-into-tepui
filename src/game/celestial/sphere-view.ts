// 「テクスチャ球」で済む天体(月・木星など)の見た目を実 ECI 位置・実半径で描く。
// 見かけ直径が閾値未満なら球自体を描かない。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/celestial-body';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { showsPhysicalSphere } from '../../render/screen-lod';
import { CelestialSurface } from '../../render/celestial-surface';
import { BodyGraticule } from '../../render/body-graticule';
import type { LineOverlay } from '../../render/line-overlay';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';
import { RingView } from './ring-view';

export class SphereView extends CelestialView {
  readonly id: OrbitingId;
  private readonly group = new THREE.Group();
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

  // radius は実半径 [m]、shape は歪みの形状データ(省略時は radius による真球)。
  // rings を渡すと環を持つ天体になる(ring-view.ts 参照)。surfaceMarkings は表面ラインの
  // LineOverlay を作るファクトリ(その天体固有のデータを持つ具象クラスを呼び出し側が渡す)。
  constructor(
    id: OrbitingId,
    private readonly surface: CelestialSurface,
    private readonly radius: number,
    shape?: ShapeDef,
    private readonly rings?: RingSystemDef,
    surfaceMarkings?: () => LineOverlay,
  ) {
    super();
    this.id = id;
    const a = shapeAxes(radius, shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
    this.outerRadius = rings === undefined
      ? radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), radius);
    this.surfaceMarkings = surfaceMarkings?.();
  }

  // 表面メッシュと環をシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.surface.addTo(this.group);
    this.graticule.addTo(this.group);
    this.surfaceMarkings?.addTo(this.group);
    scene.add(this.group);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.group.renderOrder + 1);
      scene.add(this.ring.group);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (this.ring !== undefined) this.ring.group.visible = visible;
  }

  // displayTime 時点の位置へ同期する。見かけ直径が閾値未満なら球自体(と環)を描かない。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.group.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    const apparentDiameterPx = this.lodApparentDiameterPx(
      2 * this.outerRadius, cameraSystem.activeCameraScale(pos), graphics);
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      return;
    }
    this.surface.syncLod(apparentDiameterPx);
    this.graticule.setVisible(style === 'schematic');
    this.surfaceMarkings?.setVisible(style === 'schematic');
    const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
    this.group.position.copy(fo.RtoThreeV3(pos));
    // 歪んだ天体は3軸それぞれの半軸を使う。環へ渡すのは一様スケール(赤道半径)の方で、
    // 扁平は乗せない。
    this.group.scale.copy(this.axes);
    // モデル座標は +Y が自転軸、+Z が本初子午線。同期回転する天体はこれで親を向き続ける。
    const orientation = ephemeris.poleAt(this.id, displayTime);
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
        sunDirection,
        this.sunIrradianceAt(ephemeris, pos, displayTime),
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
