// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。SphereBody の視距離圧縮
// (visDist 方式)は視直径がピクセル未満になり意味がないため、戦闘ビューでは星シェルと同じ
// カメラ追従シェル上の輝点スプライトに切り替える。マップビューは SphereBody と同じ
// 実位置・実半径の球体 — 実体表示と輝点表示は別モデルの丸ごと差し替えであり、
// SphereBody 側に視点モード分岐を足す形は取らない。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/attractor';
import { norm, sub } from '../../physics/vec3';
import { RingSystemDef, RingTextureId } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { STAR_SHELL_RADIUS } from '../../render/stars';
import { Billboard } from '../../render/billboard';
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

export class PointBody extends CelestialBody {
  readonly id: OrbitingId;
  private mesh!: THREE.Mesh;
  private ring?: RingView;
  private readonly billboard: Billboard;
  private readonly scale: number;
  private readonly opacity: number;

  // buildMesh は build() でマップビュー用の実体メッシュを作る遅延コンストラクタ、radius は
  // 実半径 [m]。rings/ringTextures を渡すとマップビューでのみ環を持つ(戦闘ビューの輝点に
  // 環はない — ring-view.ts 参照)。
  constructor(
    id: OrbitingId,
    private readonly buildMesh: () => THREE.Mesh,
    private readonly radius: number,
    brightness: PointBrightness,
    private readonly rings?: RingSystemDef,
    private readonly ringTextures?: Readonly<Partial<Record<RingTextureId, string>>>,
  ) {
    super();
    this.id = id;
    this.scale = POINT_SCALE[brightness];
    this.opacity = POINT_OPACITY[brightness];
    // 色はテクスチャ平均色を狙わず単色の白 — 恒星状の光点として過剰演出しない。
    this.billboard = new Billboard(0xffffff, -9);
  }

  // buildMesh でマップビュー用メッシュを組み立て、輝点用ビルボードとあわせてシーンへ
  // 一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.mesh = this.buildMesh();
    scene.add(this.mesh);
    if (this.rings !== undefined) {
      this.ring = new RingView(this.rings, this.radius, this.ringTextures ?? {});
      this.ring.group.renderOrder = this.mesh.renderOrder + 1;
      scene.add(this.ring.group);
    }
    scene.add(this.billboard.mesh);
  }

  // displayTime 時点の位置へ、視点モードに応じてマップビューの実体メッシュか戦闘ビューの
  // 輝点ビルボードのどちらかを同期する(常に片方は隠す)。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    const pos = ephemeris.positionOf(this.id, displayTime);
    if (cameraSystem.overviewMode) {
      // 広範囲視点は SphereBody と同じ実スケール。
      this.mesh.visible = true;
      this.mesh.position.copy(fo.RtoThreeV3(pos));
      this.mesh.scale.setScalar(this.radius);
      this.billboard.hide();
      const orientation = ephemeris.poleAt(this.id, displayTime);
      const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
      if (q !== null) this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      if (this.ring !== undefined) {
        this.ring.group.visible = true;
        this.ring.sync(this.mesh.position, this.radius, orientation === null ? null : orientation.axis, pos, cameraSystem.activeCameraScale);
      }
    } else {
      // 戦闘視点は星シェルと同じ「カメラ位置 + 実方向 × STAR_SHELL_RADIUS」に置く輝点。
      this.mesh.visible = false;
      if (this.ring !== undefined) this.ring.group.visible = false;
      const cam = cameraSystem.activeCamera;
      const dir = norm(sub(pos, cameraSystem.activeCameraPos));
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
