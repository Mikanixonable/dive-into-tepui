// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。SphereBody の視距離圧縮
// (visDist 方式)は視直径がピクセル未満になり意味がないため、戦闘ビューでは星シェルと同じ
// カメラ追従シェル上の輝点スプライトに切り替える。マップビューは SphereBody と同じ
// 実位置・実半径の球体 — 実体表示と輝点表示は別モデルの丸ごと差し替えであり、
// SphereBody 側に視点モード分岐を足す形は取らない。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { len, scale as scaleVec, sub } from '../../physics/vec3';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { STAR_SHELL_RADIUS } from '../../render/stars';
import { Billboard } from '../../render/billboard';
import { CelestialSurface } from '../../render/celestial-surface';
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
const PHYSICAL_DIAMETER_THRESHOLD_PX = 2;

export class PointBody extends CelestialBody {
  readonly id: OrbitingId;
  private surface!: CelestialSurface;
  private mesh!: THREE.Mesh;
  private ring?: RingView;
  private readonly billboard: Billboard;
  private readonly scale: number;
  private readonly opacity: number;
  private readonly outerRadius: number;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;

  // buildSurface は build() でマップビュー用の実体表面を作る遅延コンストラクタ、radius は
  // 実半径 [m]、shape は歪みの形状データ(省略時は radius による真球)。rings を渡すと
  // マップビューでのみ環を持つ(戦闘ビューの輝点に環はない — ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    private readonly buildSurface: () => CelestialSurface,
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
  }

  // buildSurface でマップビュー用の表面を組み立て、輝点用ビルボードとあわせてシーンへ
  // 一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.surface = this.buildSurface();
    this.mesh = this.surface.mesh;
    scene.add(this.mesh);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.mesh.renderOrder + 1);
      scene.add(this.ring.group);
    }
    scene.add(this.billboard.mesh);
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
    this.billboard.mesh.visible = visible;
    if (this.ring !== undefined) this.ring.group.visible = visible;
  }

  // displayTime 時点の位置へ、視点モードに応じてマップビューの実体メッシュか戦闘ビューの
  // 輝点ビルボードのどちらかを同期する(常に片方は隠す)。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    if (!this.mesh.visible && !this.billboard.mesh.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
    if (cameraSystem.overviewMode) {
      // 広範囲視点は SphereBody と同じ実スケール。
      const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
      this.surface.setSunDirection(sunDirection);
      this.mesh.visible = true;
      this.mesh.position.copy(fo.RtoThreeV3(pos));
      this.mesh.scale.copy(this.axes);
      this.billboard.hide();
      const orientation = ephemeris.poleAt(this.id, displayTime);
      const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
      if (q !== null) this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      this.surface.setRingShadowSystem(
        this.rings,
        this.mesh.position,
        this.radius,
        this.radius,
        orientation === null ? null : orientation.axis,
      );
      if (this.ring !== undefined) {
        this.ring.group.visible = true;
        this.ring.sync(
          this.mesh.position,
          this.radius,
          orientation === null ? null : orientation.axis,
          pos,
          cameraSystem.activeCameraScale,
          sunDirection,
          cameraSystem.activeCamera.position,
        );
      }
    } else {
      // 戦闘視点でも、天体本体または環外径が2px以上ならSphereBodyと同じ圧縮実体を描く。
      // それ未満だけを点へ落とし、環を天体クラスだけで無条件に捨てない。
      const rel = sub(pos, cameraSystem.activeCameraPos);
      const trueDistance = Math.max(1, len(rel));
      const projectedDiameterPx = (2 * this.outerRadius) / cameraSystem.activeCameraScale(pos);
      const showPhysical = projectedDiameterPx >= PHYSICAL_DIAMETER_THRESHOLD_PX;
      const cam = cameraSystem.activeCamera;
      const dir = scaleVec(rel, 1 / trueDistance);
      if (showPhysical) {
        const scaleFactor = POINT_BODY_VIS_DIST * (this.radius / trueDistance);
        this.mesh.visible = true;
        this.mesh.position.set(
          cam.position.x + dir.x * POINT_BODY_VIS_DIST,
          cam.position.y + dir.y * POINT_BODY_VIS_DIST,
          cam.position.z + dir.z * POINT_BODY_VIS_DIST,
        );
        const k = scaleFactor / this.radius;
        this.mesh.scale.set(this.axes.x * k, this.axes.y * k, this.axes.z * k);
        const sunDirection = ephemeris.sunDirFrom(pos, displayTime);
        this.surface.setSunDirection(sunDirection);
        const orientation = ephemeris.poleAt(this.id, displayTime);
        const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
        if (q !== null) this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        this.surface.setRingShadowSystem(
          this.rings,
          this.mesh.position,
          this.radius,
          scaleFactor,
          orientation === null ? null : orientation.axis,
        );
        this.billboard.hide();
        if (this.ring !== undefined) {
          this.ring.group.visible = true;
          this.ring.sync(
            this.mesh.position,
            scaleFactor,
            orientation === null ? null : orientation.axis,
            pos,
            cameraSystem.activeCameraScale,
            sunDirection,
            cameraSystem.activeCamera.position,
          );
        }
        return;
      }
      this.mesh.visible = false;
      if (this.ring !== undefined) this.ring.group.visible = false;
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
}
