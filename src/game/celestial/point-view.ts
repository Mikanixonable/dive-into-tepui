// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。視直径がピクセル未満に
// なるので、戦闘ビューでは星殻上の輝点スプライトに切り替える。実体表示と輝点表示は別モデルの
// 丸ごと差し替えであり、SphereView 側に視点モード分岐を足す形は取らない。見かけ直径が閾値
// 未満なら(マップビューでは輝点も出さず)実体を隠す。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { OrbitingId } from '../../physics/celestial-body';
import { RingSystemDef, ShapeDef, shapeAxes } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { spinOrientation } from '../../physics/body-orientation';
import { lambertSphereIrradiance } from '../../physics/lambert-sphere';
import { STAR_SHELL_RADIUS } from '../../render/stars';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from '../../render/billboard';
import { CelestialSurface } from '../../render/celestial-surface';
import { BodyGraticule } from '../../render/body-graticule';
import { showsPhysicalSphere } from '../../render/screen-lod';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { SunLight } from '../../render/pipeline/sun-light';
import type { SunOcclusion } from '../../render/pipeline/sun-occlusion';
import type { RenderStyle } from '../../render/render-style';
import { RingView } from './ring-view';
import { bondAlbedoOf } from '../../render/celestial-albedo';
import { SUN_IRRADIANCE_1AU } from '../../render/pipeline/sun-light';
import type { Vec3 } from '../../math/vec3';

// 輝点スプライトの一辺 [m]。星殻上へ置くので、点像の角の広がりへ星殻半径を掛けたもの。
const POINT_SPRITE_SIZE = POINT_IMAGE_ANGULAR_SIZE * STAR_SHELL_RADIUS;

// 太陽の視等級。ここから任意の視等級の放射照度が引ける。
const SUN_APPARENT_MAGNITUDE = -26.74;
// 肉眼限界の視等級と、そのとき輝点へ与える表示値。
const NAKED_EYE_LIMIT_MAGNITUDE = 6;
const NAKED_EYE_LIMIT_DISPLAY = 0.06;
// 視等級 m の放射照度 = 1 天文単位での太陽の放射照度 x 10^(-0.4(m - m_sun))。
const NAKED_EYE_LIMIT_IRRADIANCE = SUN_IRRADIANCE_1AU
  * 10 ** (-0.4 * (NAKED_EYE_LIMIT_MAGNITUDE - SUN_APPARENT_MAGNITUDE));
// 点光源の表示応答。**肉眼限界の惑星が届ける放射照度は表示値の白に対して 1e-13 の桁しかなく、
// そのまま出せばどの惑星も黒へ潰れる** — 点として見えること自体が視細胞の順応と眼球内散乱と
// いう「目の応答」であって、面の輝度の物理ではない。天体ごとの手調整ではなく、**全天体へ一律に
// 掛かる 1 つの応答**として、肉眼限界がかろうじて見える表示値になるよう決める。
const POINT_DISPLAY_GAIN = NAKED_EYE_LIMIT_DISPLAY / NAKED_EYE_LIMIT_IRRADIANCE;

const tmpPos = new THREE.Vector3();
const tmpToObserver = new THREE.Vector3();

export class PointView extends CelestialView {
  readonly id: OrbitingId;
  private readonly group = new THREE.Group();
  private ring?: RingView;
  private readonly billboard: Billboard;
  private readonly bondAlbedo: number;
  private readonly outerRadius: number;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;
  // 模式図スタイルでだけ見せる経緯度グリッド。姿勢は group の子として自然に追従する。
  private readonly graticule = new BodyGraticule();

  // surface はマップビューで見せる実体、radius は実半径 [m]、shape は歪みの形状データ
  // (省略時は radius による真球)。rings を渡すとマップビューでのみ環を持つ(戦闘ビューの
  // 輝点に環はない)。sunOcclusion と sunLight はその環が直射散乱の遮蔽と明るさを引くために要る。
  constructor(
    id: OrbitingId,
    private readonly surface: CelestialSurface,
    private readonly sunOcclusion: SunOcclusion,
    private readonly sunLight: SunLight,
    private readonly radius: number,
    shape?: ShapeDef,
    private readonly rings?: RingSystemDef,
  ) {
    super();
    this.id = id;
    this.bondAlbedo = bondAlbedoOf(id);
    this.outerRadius = rings === undefined
      ? radius
      : rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), radius);
    // 色はテクスチャ平均色を狙わず単色の白 — 恒星状の光点として過剰演出しない。
    this.billboard = new Billboard(0xffffff, -9);
    const a = shapeAxes(radius, shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
  }

  // マップビュー用の実体表面と輝点用ビルボードをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.surface.addTo(this.group);
    this.graticule.addTo(this.group);
    scene.add(this.group);
    if (this.rings !== undefined) {
      this.ring = new RingView(
        this.rings, this.radius, this.group.renderOrder + 1, this.sunOcclusion, this.sunLight,
      );
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
    graphics: GraphicsSettingsData, style: RenderStyle,
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
        this.syncBillboard(fo.RtoThreeV3(pos), pos, displayTime, ephemeris, cameraSystem.activeCamera.quaternion);
      }
      return;
    }
    this.surface.syncLod(apparentDiameterPx);
    this.graticule.setVisible(style === 'schematic');
    const orientation = ephemeris.poleAt(this.id, displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    const rings = graphics.rings ? this.rings : undefined;
    if (this.ring !== undefined) this.ring.group.visible = rings !== undefined;
    this.group.position.copy(fo.RtoThreeV3(pos));
    this.group.scale.copy(this.axes);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.billboard.hide();
    if (this.ring !== undefined && rings !== undefined) {
      this.ring.sync(
        this.group.position,
        orientation === null ? null : orientation.axis,
        pos,
        cameraSystem.activeCameraScale,
        style,
      );
    }
  }

  // 見かけ直径が閾値未満のときの共通後始末: 実体メッシュと環を隠す。
  private hidePhysical(): void {
    this.surface.hide();
    this.graticule.setVisible(false);
    if (this.ring !== undefined) this.ring.group.visible = false;
  }

  // 星殻上に、描画座標 p の方向だけを反映した輝点を置く。明るさは「いま観測者へ届く光の量」
  // — ランバート球として引いた放射照度に、点光源の表示応答を掛けたもの。
  private syncBillboard(
    p: THREE.Vector3, pos: Vec3, displayTime: number, ephemeris: Ephemeris,
    cameraQuaternion: THREE.Quaternion,
  ): void {
    const observerDistance = p.length();
    const sunDir = ephemeris.sunDirFrom(pos, displayTime);
    // 位相角は天体から見た恒星方向と観測者方向の成す角。観測者は描画原点なので -p̂ で、
    // フローティングオリジンは平行移動しかしないため、描画座標の向きは ECI の向きと一致する。
    tmpToObserver.copy(p).negate().normalize();
    const cosPhase = Math.max(-1, Math.min(1,
      sunDir.x * tmpToObserver.x + sunDir.y * tmpToObserver.y + sunDir.z * tmpToObserver.z));
    const irradiance = lambertSphereIrradiance(
      this.bondAlbedo, this.sunIrradianceAt(ephemeris, pos, displayTime),
      this.radius, observerDistance, Math.acos(cosPhase),
    );
    this.billboard.sync(
      tmpPos.copy(p).setLength(STAR_SHELL_RADIUS),
      POINT_SPRITE_SIZE,
      irradiance * POINT_DISPLAY_GAIN,
      cameraQuaternion,
    );
  }

  // 表面・環・輝点ビルボードを解放する。
  dispose(): void {
    this.group.removeFromParent();
    this.surface.dispose();
    this.graticule.dispose();
    this.ring?.dispose();
    this.billboard.mesh.removeFromParent();
    this.billboard.dispose();
  }
}
