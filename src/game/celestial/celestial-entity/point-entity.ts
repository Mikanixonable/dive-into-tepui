// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。視直径がピクセル未満に
// なるので、戦闘ビューでは星殻上の輝点スプライトに切り替える。実体表示と輝点表示は別モデルの
// 丸ごと差し替えであり、SphereEntity 側に視点モード分岐を足す形は取らない。見かけ直径が閾値
// 未満なら(マップビューでは輝点も出さず)実体を隠す。
import * as THREE from 'three/webgpu';
import { OrbitingMotion } from '../../../physics/celestial-motion';
import { shapeAxes } from '../../../physics/celestial-body-def';
import { CameraSystem } from '../../camera/camera-system';
import { FloatingOrigin } from '../../camera/floating-origin';
import { spinOrientation } from '../../../physics/body-orientation';
import { lambertSphereIrradiance } from '../../../physics/lambert-sphere';
import { STAR_SHELL_RADIUS } from '../../../render/stars';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from '../../../render/billboard';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CumulusShell } from '../../../render/cumulus-shell';
import { BodyGraticule } from '../../../render/body-graticule';
import { showsPhysicalSphere } from '../../../render/screen-lod';
import { CelestialEntity } from './celestial-entity';
import type { Aurora } from '../../../render/aurora';
import type { CelestialClass } from './celestial-entity-def';
import { CelestialMotion } from '../../../physics/celestial-motion';
import type { GeostationaryOverlay } from './geostationary-overlay';
import type { StarEntity } from './star-entity';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import type { LineOverlay } from '../../../render/line-overlay';
import type { MarkerManager } from '../../marker/marker-manager';
import type { SunLight } from '../../../render/pipeline/sun-light';
import type { CumulusShadow, SunOcclusion } from '../../../render/pipeline/sun-occlusion';
import type { RenderStyle } from '../../../render/render-style';
import { RingView } from './ring-view';
import { DEFAULT_ALBEDO, rec709Luminance, type Albedo } from '../../../render/celestial-albedo';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import { SUN_IRRADIANCE_1AU } from '../../../render/pipeline/sun-light';
import { norm, sub, v3 } from '../../../math/vec3';
import type { Vec3 } from '../../../math/vec3';

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

// オーロラの明滅・波打ちが進む速さ [1/s]。
const AURORA_PHASE_RATE = 0.02;

const tmpPos = new THREE.Vector3();
const tmpToObserver = new THREE.Vector3();
const tmpSpin = new THREE.Quaternion();

export class PointEntity extends CelestialEntity {
  // 位置と自転姿勢だけを載せる入れ物。扁平のスケールは shapeGroup が持つ — オーロラは実寸 [m]
  // の頂点を持つので、ここを拡大すると天体半径倍に膨らむ。
  private readonly group = new THREE.Group();
  private readonly shapeGroup = new THREE.Group();
  private ring?: RingView;
  // 輝点スプライト。グローテクスチャの生成が DOM を要するので build まで作らない。
  private billboard!: Billboard;
  private readonly bondAlbedo: number;
  // 実半径 [m]。
  private readonly radius: number;
  private readonly outerRadius: number;
  // 自転姿勢が乗る前のローカル半軸 [m](真球なら3軸とも radius)。
  private readonly axes: THREE.Vector3;
  // 模式図スタイルでだけ見せる経緯度グリッド。姿勢は group の子として自然に追従する。
  private readonly graticule = new BodyGraticule();
  // 描画座標のベクトルを天体固定の向きへ戻す回転。遮蔽パスへ渡すあいだだけ生きていればよい。
  private readonly bodyFromWorld = new THREE.Matrix4();

  // surface はマップビューで見せる実体。実半径・歪みの形状・環は motion の定義から引き、
  // 環はマップビューでのみ描く(戦闘ビューの輝点に環はない)。surfaceMarkings は模式図で
  // だけ見せる天体固有の表面ライン、auroras は極を囲むカーテン(層ごとに1枚)、
  // mapOverlay はマップ専用の同期軌道リング、cumulus は地表の上に浮く不透明な積雲の殻。
  // 持たない天体では null / 空。
  constructor(
    motion: OrbitingMotion,
    name: string,
    bodyClass: CelestialClass,
    private readonly surface: CelestialSurface,
    atmosphereOptics: AtmosphereOptics | null = null,
    private readonly surfaceMarkings: LineOverlay | null = null,
    private readonly auroras: readonly Aurora[] = [],
    private readonly mapOverlay: GeostationaryOverlay | null = null,
    private readonly cumulus: CumulusShell | null = null,
  ) {
    super(motion, name, bodyClass, atmosphereOptics);
    const def = motion.def;
    this.radius = def.radius;
    this.bondAlbedo = surface.photometry?.bondAlbedo ?? rec709Luminance(DEFAULT_ALBEDO);
    this.outerRadius = def.rings === undefined
      ? def.radius
      : def.rings.bands.reduce((maxRadius, band) => Math.max(maxRadius, band.outerRadius), def.radius);
    const a = shapeAxes(def.radius, def.shape);
    this.axes = new THREE.Vector3(a.x, a.y, a.z);
  }

  get lightSourceAlbedo(): Albedo | null { return this.surface.photometry?.lightSourceAlbedo ?? null; }

  get surfaceTextureUrl(): string | null { return this.surface.textureUrl; }

  // マップビュー用の実体表面と輝点用ビルボードをシーンへ一度だけ登録する。
  build(scene: THREE.Scene, sunOcclusion: SunOcclusion, sunLight: SunLight): void {
    // 色はテクスチャ平均色を狙わず単色の白 — 恒星状の光点として過剰演出しない。
    this.billboard = new Billboard(0xffffff, -9);
    this.surface.addTo(this.shapeGroup);
    this.cumulus?.addTo(this.shapeGroup);
    this.graticule.addTo(this.shapeGroup);
    this.surfaceMarkings?.addTo(this.shapeGroup);
    this.group.add(this.shapeGroup);
    for (const aurora of this.auroras) this.group.add(aurora.mesh);
    scene.add(this.group);
    if (this.rings !== null) {
      this.ring = new RingView(
        this.rings, this.radius, this.group.renderOrder + 1, sunOcclusion, sunLight,
      );
      scene.add(this.ring.group);
    }
    scene.add(this.billboard.mesh);
    this.mapOverlay?.build(scene);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.billboard.mesh.visible = visible;
    this.ring?.setVisible(visible);
  }

  // displayTime 時点の位置へ実体メッシュか輝点ビルボードのどちらかを同期する(常に片方は
  // 隠す)。見かけ直径が閾値未満では実体を隠す(戦闘視点は輝点へ切り替え、広範囲視点は
  // 輝点も出さない)。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, star: StarEntity | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.group.visible && !this.billboard.mesh.visible) return;
    const pos = this.stateAt(displayTime).r;
    const apparentDiameterPx = this.lodApparentDiameterPx(
      2 * this.outerRadius, cameraSystem.activeCameraScale(pos), graphics);
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      if (cameraSystem.overviewMode) {
        this.billboard.hide();
      } else {
        this.syncBillboard(fo.RtoThreeV3(pos), pos, displayTime, star, cameraSystem.activeCamera.quaternion);
      }
      return;
    }
    this.surface.syncLod(apparentDiameterPx);
    this.surface.setCloudAmount(graphics.clouds ? 1 : 0);
    if (graphics.clouds) {
      this.cumulus?.setDetail(graphics.cumulusDetail);
      this.cumulus?.syncLod(apparentDiameterPx);
    } else {
      this.cumulus?.hide();
    }
    this.graticule.setVisible(style === 'schematic');
    this.surfaceMarkings?.setVisible(style === 'schematic');
    this.syncAuroras(displayTime, graphics.aurora);
    const orientation = this.motion.orientationAt(displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    this.group.position.copy(fo.RtoThreeV3(pos));
    this.shapeGroup.scale.copy(this.axes);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.billboard.hide();
    this.ring?.sync(
      this.group.position,
      orientation === null ? null : orientation.axis,
      pos,
      cameraSystem.activeCameraScale,
      graphics,
      style,
    );
  }

  // 遮蔽パスへ渡す積雲の殻。姿勢は自転位相まで込みで組む — 軸だけでは場が地表と一緒に回らない。
  override cumulusShadowAt(fo: FloatingOrigin, displayTime: number): CumulusShadow | null {
    if (this.cumulus === null) return null;
    const orientation = this.motion.orientationAt(displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    if (q === null) {
      this.bodyFromWorld.identity();
    } else {
      this.bodyFromWorld.makeRotationFromQuaternion(tmpSpin.set(q.x, q.y, q.z, q.w).invert());
    }
    return {
      center: fo.RtoThreeV3(this.stateAt(displayTime).r),
      surfaceRadius: this.radius,
      axes: this.axes,
      topAltitude: this.cumulus.topAltitude,
      bodyFromWorld: this.bodyFromWorld,
      field: this.cumulus.field,
    };
  }

  // マップ専用の同期軌道リングを、この1フレームの表示状態へ同期する。
  override syncMapOverlay(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem,
    markerManager: MarkerManager | null, celestialBodies: readonly CelestialMotion[], visible: boolean,
  ): void {
    this.mapOverlay?.sync(
      this.motion, displayTime, fo, cameraSystem, markerManager, celestialBodies, visible);
  }

  // オーロラの波打ち・明滅を表示時刻へ進める。
  private syncAuroras(displayTime: number, visible: boolean): void {
    const phase = displayTime * AURORA_PHASE_RATE;
    for (const aurora of this.auroras) {
      aurora.mesh.visible = visible;
      if (visible) aurora.sync(phase);
    }
  }

  // 見かけ直径が閾値未満のときの共通後始末: 実体メッシュと環を隠す。
  private hidePhysical(): void {
    this.surface.hide();
    this.cumulus?.hide();
    this.graticule.setVisible(false);
    this.surfaceMarkings?.setVisible(false);
    for (const aurora of this.auroras) aurora.mesh.visible = false;
    this.ring?.setVisible(false);
  }

  // 星殻上に、描画座標 p の方向だけを反映した輝点を置く。明るさは「いま観測者へ届く光の量」
  // — ランバート球として引いた放射照度に、点光源の表示応答を掛けたもの。
  private syncBillboard(
    p: THREE.Vector3, pos: Vec3, displayTime: number, star: StarEntity | null,
    cameraQuaternion: THREE.Quaternion,
  ): void {
    const observerDistance = p.length();
    const sunDir = star === null ? v3(1, 0, 0) : norm(sub(star.stateAt(displayTime).r, pos));
    // 位相角は天体から見た恒星方向と観測者方向の成す角。観測者は描画原点なので -p̂ で、
    // フローティングオリジンは平行移動しかしないため、描画座標の向きは ECI の向きと一致する。
    tmpToObserver.copy(p).negate().normalize();
    const cosPhase = Math.max(-1, Math.min(1,
      sunDir.x * tmpToObserver.x + sunDir.y * tmpToObserver.y + sunDir.z * tmpToObserver.z));
    const irradiance = lambertSphereIrradiance(
      this.bondAlbedo, this.sunIrradianceAt(star, pos, displayTime),
      this.radius, observerDistance, Math.acos(cosPhase),
    );
    this.billboard.sync(
      tmpPos.copy(p).setLength(STAR_SHELL_RADIUS),
      POINT_SPRITE_SIZE,
      irradiance * POINT_DISPLAY_GAIN,
      cameraQuaternion,
    );
  }

  // 表面・積雲の殻・環・オーロラ・輝点ビルボードを解放する。
  dispose(): void {
    this.group.removeFromParent();
    this.surface.dispose();
    this.cumulus?.dispose();
    this.graticule.dispose();
    this.surfaceMarkings?.dispose();
    for (const aurora of this.auroras) aurora.dispose();
    this.mapOverlay?.dispose();
    this.ring?.dispose();
    this.billboard.mesh.removeFromParent();
    this.billboard.dispose();
  }
}
