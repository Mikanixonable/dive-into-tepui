// 「テクスチャ球」で済む天体(月・木星など)の見た目を実 ECI 位置・実半径で描く。
// 球メッシュは screen-lod.ts の分割段ラダーに乗る: 段ごとに単位球メッシュを作り分けて
// おき(WebGPU は mesh.geometry の差し替えが効かないため)、見かけ直径から選んだ1段だけを
// visible にする。見かけ直径が閾値未満なら球自体を描かない。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/celestial-body';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { showsPhysicalSphere, sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from '../../render/screen-lod';
import { CelestialSurface } from '../../render/celestial-surface';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { RingView } from './ring-view';

export class SphereView extends CelestialView {
  readonly id: OrbitingId;
  private readonly surfaces: ReadonlyMap<SphereLodLevel, CelestialSurface>;
  private readonly group = new THREE.Group();
  private activeLevel: SphereLodLevel | null = null;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;
  // 環を含めた最外半径 [m]。radius だけで見かけ直径を判定すると、本体が閾値未満でも
  // 環がまだ画面に見える大きさのまま球体ごと隠してしまう。
  private readonly outerRadius: number;
  private ring?: RingView;

  // buildSurface は分割段(screen-lod.ts の SPHERE_LOD_LADDER の要素)ごとに表面を作る
  // 遅延コンストラクタ、radius は実半径 [m]、shape は歪みの形状データ(省略時は radius に
  // よる真球)。rings を渡すと環を持つ天体になる(ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    buildSurface: (level: SphereLodLevel) => CelestialSurface,
    private readonly radius: number,
    shape?: ShapeDef,
    private readonly rings?: RingSystemDef,
  ) {
    super();
    this.id = id;
    const a = shapeAxes(radius, shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
    this.outerRadius = rings === undefined
      ? radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), radius);
    const surfaces = new Map<SphereLodLevel, CelestialSurface>();
    for (const level of SPHERE_LOD_LADDER) {
      const surface = buildSurface(level);
      surface.mesh.visible = false;
      surfaces.set(level, surface);
    }
    this.surfaces = surfaces;
  }

  // 分割段ごとの表面メッシュと環をシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    for (const surface of this.surfaces.values()) this.group.add(surface.mesh);
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
    graphics: GraphicsSettingsData,
  ): void {
    if (!this.group.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    const apparentDiameterPx = this.lodApparentDiameterPx(
      2 * this.outerRadius, cameraSystem.activeCameraScale(pos), graphics);
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      return;
    }
    this.syncLod(apparentDiameterPx);
    const activeSurface = this.surfaces.get(this.activeLevel!)!;
    const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
    activeSurface.setSunDirection(new THREE.Vector3(sunDirection.x, sunDirection.y, sunDirection.z));
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
      );
    } else if (this.ring !== undefined) {
      this.ring.group.visible = false;
    }
  }

  // 見かけ直径が閾値未満のときの共通後始末: 全段のメッシュと環を隠す。
  private hidePhysical(): void {
    for (const surface of this.surfaces.values()) surface.mesh.visible = false;
    this.activeLevel = null;
    if (this.ring !== undefined) this.ring.group.visible = false;
  }

  // 見かけ直径から球分割段を選び、その段のメッシュだけを visible にする。
  private syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [lvl, surface] of this.surfaces) surface.mesh.visible = lvl === level;
  }

  // 全分割段の表面と環を解放し、group を親から外す。
  dispose(): void {
    this.group.removeFromParent();
    for (const surface of this.surfaces.values()) surface.dispose();
    this.ring?.dispose();
  }
}
