// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。SphereBody の視距離圧縮
// (visDist 方式)は視直径がピクセル未満になり意味がないため、戦闘ビューでは星シェルと同じ
// カメラ追従シェル上の輝点スプライトに切り替える。マップビューは SphereBody と同じ
// 実位置・実半径の球体 — 実体表示と輝点表示は別モデルの丸ごと差し替えであり、
// SphereBody 側に視点モード分岐を足す形は取らない。球メッシュ自体は SphereBody と同じく
// screen-lod.ts の分割段ラダーに乗り、見かけ直径が閾値未満なら(マップビューでは輝点も
// 出さず)実体を隠す。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { Vec3, len, scale as scaleVec, sub } from '../../physics/vec3';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { STAR_SHELL_RADIUS } from '../../render/stars';
import { Billboard } from '../../render/billboard';
import { CelestialSurface } from '../../render/celestial-surface';
import { apparentSizePx, showsPhysicalSphere, sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from '../../render/screen-lod';
import { CelestialBody } from './celestial-body';
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
const POINT_BODY_VIS_DIST = 5e7;

export class PointBody extends CelestialBody {
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

  // displayTime 時点の位置へ、視点モードに応じて広範囲視点の実体メッシュか戦闘視点の
  // 輝点ビルボードのどちらかを同期する(常に片方は隠す)。見かけ直径は圧縮前の真の位置から
  // 求め、閾値未満では実体を隠す(戦闘視点は輝点へ切り替え、広範囲視点は輝点も出さない)。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    if (!this.group.visible && !this.billboard.mesh.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    const apparentDiameterPx = apparentSizePx(2 * this.outerRadius, cameraSystem.activeCameraScale(pos));
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      if (cameraSystem.overviewMode) {
        this.billboard.hide();
      } else {
        this.syncBillboard(pos, cameraSystem);
      }
      return;
    }
    this.syncLod(apparentDiameterPx);
    const activeSurface = this.surfaces.get(this.activeLevel!)!;
    const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
    activeSurface.setSunDirection(sunDirection);
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (cameraSystem.overviewMode) {
      // 広範囲視点は SphereBody と同じ実スケール。
      this.group.position.copy(fo.RtoThreeV3(pos));
      this.group.scale.copy(this.axes);
      this.billboard.hide();
      if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
      activeSurface.setRingShadowSystem(
        this.rings,
        this.group.position,
        this.radius,
        this.radius,
        orientation === null ? null : orientation.axis,
      );
      if (this.ring !== undefined) {
        this.ring.group.visible = true;
        this.ring.sync(
          this.group.position,
          this.radius,
          orientation === null ? null : orientation.axis,
          pos,
          cameraSystem.activeCameraScale,
          sunDirection,
          cameraSystem.activeCamera.position,
        );
      }
      return;
    }
    // 戦闘視点でも見かけ直径が閾値以上なら SphereBody と同じ圧縮実体を描く。
    const rel = sub(pos, cameraSystem.activeCameraPos);
    const trueDistance = Math.max(1, len(rel));
    const cam = cameraSystem.activeCamera;
    const dir = scaleVec(rel, 1 / trueDistance);
    const scaleFactor = POINT_BODY_VIS_DIST * (this.radius / trueDistance);
    this.group.position.set(
      cam.position.x + dir.x * POINT_BODY_VIS_DIST,
      cam.position.y + dir.y * POINT_BODY_VIS_DIST,
      cam.position.z + dir.z * POINT_BODY_VIS_DIST,
    );
    const k = scaleFactor / this.radius;
    this.group.scale.set(this.axes.x * k, this.axes.y * k, this.axes.z * k);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    activeSurface.setRingShadowSystem(
      this.rings,
      this.group.position,
      this.radius,
      scaleFactor,
      orientation === null ? null : orientation.axis,
    );
    this.billboard.hide();
    if (this.ring !== undefined) {
      this.ring.group.visible = true;
      this.ring.sync(
        this.group.position,
        scaleFactor,
        orientation === null ? null : orientation.axis,
        pos,
        cameraSystem.activeCameraScale,
        sunDirection,
        cameraSystem.activeCamera.position,
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

  // 星シェル上に、カメラから見た方向だけを反映した輝点を置く。
  private syncBillboard(pos: Vec3, cameraSystem: CameraSystem): void {
    const cam = cameraSystem.activeCamera;
    const rel = sub(pos, cameraSystem.activeCameraPos);
    const trueDistance = Math.max(1, len(rel));
    const dir = scaleVec(rel, 1 / trueDistance);
    this.billboard.sync(
      tmpPos.set(
        cam.position.x + dir.x * STAR_SHELL_RADIUS,
        cam.position.y + dir.y * STAR_SHELL_RADIUS,
        cam.position.z + dir.z * STAR_SHELL_RADIUS,
      ),
      this.scale,
      this.opacity,
      cam.quaternion,
    );
  }
}
