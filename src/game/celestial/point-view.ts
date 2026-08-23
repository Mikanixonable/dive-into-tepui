// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。視直径がピクセル未満に
// なるので、戦闘ビューでは星殻上の輝点スプライトに切り替える。実体表示と輝点表示は別モデルの
// 丸ごと差し替えであり、SphereView 側に視点モード分岐を足す形は取らない。球メッシュ自体は
// SphereView と同じく screen-lod.ts の分割段ラダーに乗り、見かけ直径が閾値未満なら
// (マップビューでは輝点も出さず)実体を隠す。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/celestial-body';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { STAR_SHELL_RADIUS } from '../../render/stars';
import { Billboard } from '../../render/billboard';
import { CelestialSurface } from '../../render/celestial-surface';
import { showsPhysicalSphere, sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from '../../render/screen-lod';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import { RingView } from './ring-view';

// 見かけの明るさ3段階。金星(-4等)・木星(-2等)が bright、水星・火星・土星(0〜+1等台)が
// medium、天王星(+5.7等、肉眼限界+6等付近)が faint — レジストリ側で天体ごとに選ぶ。
export type PointBrightness = 'bright' | 'medium' | 'faint';

const POINT_SCALE: Record<PointBrightness, number> = {
  bright: 2.4e5,
  medium: 1.3e5,
  faint: 6e4,
};
const POINT_OPACITY: Record<PointBrightness, number> = {
  bright: 1,
  medium: 0.75,
  faint: 0.45,
};

const tmpPos = new THREE.Vector3();

export class PointView extends CelestialView {
  readonly id: OrbitingId;
  private readonly surfaces: ReadonlyMap<SphereLodLevel, CelestialSurface>;
  private readonly group = new THREE.Group();
  private activeLevel: SphereLodLevel | null = null;
  private ring?: RingView;
  private readonly billboard: Billboard;
  private readonly scale: number;
  private readonly opacity: number;
  private readonly outerRadius: number;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;

  // buildSurface は分割段(screen-lod.ts の SPHERE_LOD_LADDER の要素)ごとにマップビュー用の
  // 実体表面を作る遅延コンストラクタ、radius は実半径 [m]、shape は歪みの形状データ
  // (省略時は radius による真球)。rings を渡すとマップビューでのみ環を持つ(戦闘ビューの
  // 輝点に環はない — ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    buildSurface: (level: SphereLodLevel) => CelestialSurface,
    private readonly radius: number,
    brightness: PointBrightness,
    shape?: ShapeDef,
    private readonly rings?: RingSystemDef,
  ) {
    super();
    this.id = id;
    this.scale = POINT_SCALE[brightness];
    this.opacity = POINT_OPACITY[brightness];
    this.outerRadius = rings === undefined
      ? radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), radius);
    // 色はテクスチャ平均色を狙わず単色の白 — 恒星状の光点として過剰演出しない。
    this.billboard = new Billboard(0xffffff, -9);
    const a = shapeAxes(radius, shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
    const surfaces = new Map<SphereLodLevel, CelestialSurface>();
    for (const level of SPHERE_LOD_LADDER) {
      const surface = buildSurface(level);
      surface.mesh.visible = false;
      surfaces.set(level, surface);
    }
    this.surfaces = surfaces;
  }

  // buildSurface でマップビュー用の分割段ごとの表面を組み立て、輝点用ビルボードと
  // あわせてシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    for (const surface of this.surfaces.values()) this.group.add(surface.mesh);
    scene.add(this.group);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.group.renderOrder + 1);
      scene.add(this.ring.group);
    }
    scene.add(this.billboard.mesh);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.billboard.mesh.visible = visible;
    if (this.ring !== undefined) this.ring.group.visible = visible;
  }

  // displayTime 時点の位置へ実体メッシュか輝点ビルボードのどちらかを同期する(常に片方は
  // 隠す)。見かけ直径が閾値未満では実体を隠す(戦闘視点は輝点へ切り替え、広範囲視点は
  // 輝点も出さない)。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    graphics: GraphicsSettingsData,
  ): void {
    if (!this.group.visible && !this.billboard.mesh.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    const apparentDiameterPx = this.lodApparentDiameterPx(
      2 * this.outerRadius, cameraSystem.activeCameraScale(pos), graphics);
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      if (cameraSystem.overviewMode) {
        this.billboard.hide();
      } else {
        this.syncBillboard(fo.RtoThreeV3(pos), cameraSystem.activeCamera.quaternion);
      }
      return;
    }
    this.syncLod(apparentDiameterPx);
    const activeSurface = this.surfaces.get(this.activeLevel!)!;
    const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
    activeSurface.setSunDirection(new THREE.Vector3(sunDirection.x, sunDirection.y, sunDirection.z));
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const axis = orientation === null ? null : new THREE.Vector3(orientation.axis.x, orientation.axis.y, orientation.axis.z);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    // 環を切ったときは、帯そのものだけでなく本体表面へ落ちる環の影も消す。
    const rings = graphics.rings ? this.rings : undefined;
    if (this.ring !== undefined) this.ring.group.visible = rings !== undefined;
    this.group.position.copy(fo.RtoThreeV3(pos));
    this.group.scale.copy(this.axes);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.billboard.hide();
    activeSurface.setRingShadowSystem(rings, this.group.position, axis);
    if (this.ring !== undefined && rings !== undefined) {
      this.ring.sync(
        this.group.position,
        orientation === null ? null : orientation.axis,
        pos,
        cameraSystem.activeCameraScale,
        sunDirection,
      );
    }
  }

  // 見かけ直径が閾値未満のときの共通後始末: 全段の実体メッシュと環を隠す。
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

  // 星殻上に、描画座標 p の方向だけを反映した輝点を置く。
  private syncBillboard(p: THREE.Vector3, cameraQuaternion: THREE.Quaternion): void {
    this.billboard.sync(
      tmpPos.copy(p).setLength(STAR_SHELL_RADIUS),
      this.scale,
      this.opacity,
      cameraQuaternion,
    );
  }

  // 全分割段の表面・環・輝点ビルボードを解放する。
  dispose(): void {
    this.group.removeFromParent();
    for (const surface of this.surfaces.values()) surface.dispose();
    this.ring?.dispose();
    this.billboard.mesh.removeFromParent();
    this.billboard.dispose();
  }
}
