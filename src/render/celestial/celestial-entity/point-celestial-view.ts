// 戦闘ビューで肉眼の「明るい星」程度にしか見えない惑星の見た目。見かけ直径が閾値未満なら実体を
// 隠し、戦闘ビューでは星殻上の輝点スプライトへ切り替える。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { shapeAxes, type RingSystemDef } from '../../../physics/celestial-body-def';
import { FloatingOrigin } from '../../camera/floating-origin';
import { spinOrientation } from '../../../physics/body-orientation';
import { lambertSphereIrradiance } from '../../../physics/lambert-sphere';
import { STAR_SHELL_RADIUS } from '../../stars';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from '../../billboard';
import {
  createCelestialSurfaceFrame,
  type CelestialSurfaceDiagnostics,
  type CelestialSurfaceLike,
} from '../celestial-surface';
import { BodyGraticule } from '../body-graticule';
import { showsPhysicalSphere } from '../screen-lod';
import { writeBodyFromWorld } from '../body-frame';
import type { RingMaterials } from '../ring';
import { RingView } from '../ring-view';
import { DEFAULT_ALBEDO, rec709Luminance, type Albedo } from '../../celestial-albedo';
import { irradianceAtDistance, SUN_IRRADIANCE_1AU } from '../../pipeline/sun-light';
import { norm, sub, v3, type Vec3 } from '../../../math/vec3';
import type { CameraFrame } from '../../camera/camera-frame';
import type { CloudPresentation } from '../../cloud/cloud-presentation';
import type { Aurora } from '../aurora';
import type { GeostationaryOverlay } from './geostationary-overlay';
import type { GraphicsSettingsData } from '../../graphics-settings';
import type { LineOverlay } from '../line-overlay';
import type { MarkerSlots } from '../../../game/marker/marker-slots';
import type { ShadowCumulus } from '../../pipeline/shadow/cloud-shadow-renderer';
import type { RenderStyle } from '../../render-style';
import type { AtmosphereClouds, AtmosphereOptics } from '../../atmosphere';
import type { CelestialBody } from '../../../physics/celestial-body';
import { CelestialView, type DefinedCelestialBody, type StellarLightSource } from './celestial-view';
import type { GpuTimingSink } from '../../gpu-timings';

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
// 点光源の表示応答。肉眼限界の惑星をかろうじて見える表示値にする、全天体共通の目の応答。
const POINT_DISPLAY_GAIN = NAKED_EYE_LIMIT_DISPLAY / NAKED_EYE_LIMIT_IRRADIANCE;
// オーロラの明滅・波打ちが進む速さ [1/s]。
const AURORA_PHASE_RATE = 0.02;

const tmpPos = new THREE.Vector3();
const tmpToObserver = new THREE.Vector3();

// 点表現の外径計算に使う環定義を、環を持てる天体だけから取り出す。
function ringsOf(motion: DefinedCelestialBody): RingSystemDef | null {
  return 'rings' in motion.def ? motion.def.rings ?? null : null;
}

// 恒星から pos が受ける放射照度。恒星のない星系では、1AU の太陽光を使う。
function sunIrradianceAt(star: StellarLightSource | null, pos: Vec3, displayTime: number): number {
  if (star === null) return SUN_IRRADIANCE_1AU;
  const starPos = star.motion.stateAt(displayTime).r;
  const distance = Math.hypot(pos.x - starPos.x, pos.y - starPos.y, pos.z - starPos.z);
  return distance <= 0 ? SUN_IRRADIANCE_1AU : irradianceAtDistance(star.stellarLight.radiantIntensity, distance);
}

export class PointCelestialView extends CelestialView {
  // 位置と自転姿勢だけを載せる入れ物。扁平のスケールは shapeGroup が持つ — オーロラは実寸 [m]
  // の頂点を持つので、ここを拡大すると天体半径倍に膨らむ。
  private readonly group = new THREE.Group();
  private readonly shapeGroup = new THREE.Group();
  private ring: RingView | null = null;
  // 輝点スプライト。グローテクスチャの生成が DOM を要するので build まで作らない。
  private billboard!: Billboard;
  // 模式図スタイルでだけ見せる経緯度グリッド。姿勢は group の子として自然に追従する。
  private readonly graticule = new BodyGraticule();
  // 描画座標のベクトルを天体固定の向きへ戻す回転。影パスへ渡すあいだだけ生きていればよい。
  private readonly bodyFromWorld = new THREE.Matrix4();
  private surfaceFrame = 0;
  // 自転姿勢が乗る前のローカル半軸 [m]。物理定義から build 時に作る描画用キャッシュ。
  private readonly axes = new THREE.Vector3();

  // surface はマップビューで見せる実体。surfaceMarkings は模式図でだけ見せる天体固有の表面
  // ライン、auroras は極を囲むカーテン(層ごとに1枚)、mapOverlay はマップ専用の同期軌道リング、
  // cumulus は地表の上に浮く不透明な積雲の殻。持たない天体では null / 空。
  public constructor(
    private readonly surface: CelestialSurfaceLike,
    private readonly optics: AtmosphereOptics | null = null,
    private readonly surfaceMarkings: LineOverlay | null = null,
    private readonly auroras: readonly Aurora[] = [],
    private readonly mapOverlay: GeostationaryOverlay | null = null,
    private readonly cumulus: CloudPresentation | null = null,
  ) { super(); }

  public override get atmosphereOptics(): AtmosphereOptics | null { return this.optics; }

  public get lightSourceAlbedo(): Albedo | null { return this.surface.photometry?.lightSourceAlbedo ?? null; }

  public get surfaceTextureUrl(): string | null { return this.surface.textureUrl; }

  public override get surfaceDiagnostics(): CelestialSurfaceDiagnostics | null {
    return this.surface.diagnostics;
  }

  public override rings(motion: DefinedCelestialBody): RingSystemDef | null { return ringsOf(motion); }

  // マップビュー用の実体表面と輝点用ビルボードをシーンへ一度だけ登録する。
  public build(motion: CelestialMotion, scene: THREE.Scene, ringMaterials: RingMaterials): void {
    // 輝点は単色(SPEC/RENDERING.md「画面上の大きさに基づく詳細度」節)。
    const def = motion.def;
    const axes = shapeAxes(def.radius, 'shape' in def ? def.shape : undefined);
    this.axes.set(axes.x, axes.y, axes.z);
    this.billboard = new Billboard(0xffffff, -9);
    this.surface.addTo(this.shapeGroup);
    this.cumulus?.addTo(this.shapeGroup);
    this.graticule.addTo(this.shapeGroup);
    this.surfaceMarkings?.addTo(this.shapeGroup);
    this.group.add(this.shapeGroup);
    for (const aurora of this.auroras) this.group.add(aurora.mesh);
    scene.add(this.group);
    const rings = this.rings(motion);
    if (rings !== null) {
      this.ring = new RingView(rings, motion.def.radius, this.group.renderOrder + 1, ringMaterials);
      scene.add(this.ring.group);
    }
    scene.add(this.billboard.mesh);
    this.mapOverlay?.build(scene);
  }

  // displayTime 時点の位置へ実体メッシュか輝点ビルボードのどちらかを同期する(常に片方は隠す)。
  public sync(
    motion: CelestialMotion, displayTime: number, camera: CameraFrame,
    star: StellarLightSource | null, graphics: GraphicsSettingsData, style: RenderStyle,
    visible: boolean,
  ): void {
    this.group.visible = visible;
    if (!visible) {
      this.billboard.hide();
      this.ring?.hide();
      return;
    }
    const pos = motion.stateAt(displayTime).r;
    const rings = this.rings(motion);
    const outerRadius = rings === null
      ? motion.def.radius
      : Math.max(motion.def.radius, ...rings.bands.map((band) => band.outerRadius));
    const apparentDiameterPx = (2 * outerRadius / camera.radialScale(pos)) * graphics.lodBias;
    // 閾値未満は実体を畳み、戦闘ビューなら輝点だけを置く。
    if (!showsPhysicalSphere(apparentDiameterPx)) {
      this.hidePhysical();
      if (camera.mode === 'map') this.billboard.hide();
      else this.syncBillboard(
        camera.floatingOrigin.RtoThreeV3(pos), pos, motion.def.radius, displayTime, star,
        camera.camera.quaternion);
      return;
    }
    // 表面の分割段と雲。
    this.surface.syncLod(apparentDiameterPx);
    if (graphics.clouds) {
      this.cumulus?.setCloudsVisible(true);
      this.cumulus?.setDetail(graphics.cumulusDetail);
      this.cumulus?.syncLod(apparentDiameterPx);
    } else {
      this.cumulus?.setCloudsVisible(false);
    }
    this.cumulus?.setAtmosphereCloudsVisible(
      graphics.clouds && graphics.cirrus,
      graphics.clouds && graphics.translucentCumulus,
    );
    // 模式図の重ね書きとオーロラ。
    this.graticule.setVisible(style === 'schematic');
    this.surfaceMarkings?.setVisible(style === 'schematic');
    this.syncAuroras(displayTime, graphics.aurora);
    // 位置・扁平・自転姿勢。
    const orientation = motion.orientationAt(displayTime);
    const q = orientation === null ? null : spinOrientation(orientation.axis, orientation.spinAngle);
    this.group.position.copy(camera.floatingOrigin.RtoThreeV3(pos));
    this.shapeGroup.scale.copy(this.axes);
    if (q !== null) this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.surface.syncFrame(createCelestialSurfaceFrame(
      camera.camera,
      this.group.position,
      this.group.quaternion,
      this.axes,
      this.surfaceFrame++,
      performance.now(),
      style,
    ));
    this.billboard.hide();
    this.ring?.sync(
      this.group.position, orientation === null ? null : orientation.axis, pos,
      camera.scale, graphics, style,
    );
  }

  // 影パスへ渡す積雲の殻。**描いている殻だけが影を落とす。** 姿勢は自転位相まで込みで組む —
  // 軸だけでは場が地表と一緒に回らない。
  public cumulusShadowAt(
    motion: DefinedCelestialBody, fo: FloatingOrigin, displayTime: number,
  ): ShadowCumulus | null {
    // 本体または雲殻を描いていないフレームは、影の入力にも含めない。
    if (this.cumulus === null || !this.group.visible || !this.cumulus.visible) return null;
    writeBodyFromWorld(this.bodyFromWorld, motion, displayTime);
    return {
      center: fo.RtoThreeV3(motion.stateAt(displayTime).r),
      surfaceRadius: motion.def.radius,
      axes: this.axes,
      topAltitude: this.cumulus.topAltitude,
      bodyFromWorld: this.bodyFromWorld,
      field: this.cumulus.field,
    };
  }

  // 大気の散乱へ立てる雲。**雲全体を描くときだけ立つ。** 姿勢は自転位相まで込みで組む —
  // 軸だけでは場が地表と一緒に回らない。**姿勢はこの1体ぶんの実体で返す** — 大気パスが読むのは
  // 描画のときなので、影へ渡す使い回しの実体を渡すと、同期のあいだに書き換わる。
  public override atmosphereCloudsAt(
    motion: DefinedCelestialBody, displayTime: number,
  ): AtmosphereClouds | null {
    if (this.cumulus === null || !this.group.visible || !this.cumulus.cloudsVisible) return null;
    return {
      field: this.cumulus.field,
      bodyFromWorld: writeBodyFromWorld(new THREE.Matrix4(), motion, displayTime),
    };
  }

  // 物理球として厚い雲か薄い雲を描くフレームの場だけを、表示時刻へ焼く。
  public override bakeClouds(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    if (!this.group.visible || !this.cumulus?.cloudsVisible) return;
    this.cumulus.bake(renderer, displayTime, gpu);
  }

  // マップ専用の同期軌道リングを、この1フレームの表示状態へ同期する。
  public syncMapOverlay(
    motion: CelestialMotion, displayTime: number, camera: CameraFrame,
    markers: MarkerSlots, celestialBodies: readonly CelestialBody[], visible: boolean,
  ): void {
    this.mapOverlay?.sync(motion, displayTime, camera, markers, celestialBodies, visible);
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
    this.cumulus?.setCloudsVisible(false);
    this.graticule.setVisible(false);
    this.surfaceMarkings?.setVisible(false);
    for (const aurora of this.auroras) aurora.mesh.visible = false;
    this.ring?.hide();
  }

  // 星殻上に、描画座標 p の方向だけを反映した輝点を置く。明るさは「いま観測者へ届く光の量」
  // — ランバート球として引いた放射照度に、点光源の表示応答を掛けたもの。
  private syncBillboard(
    p: THREE.Vector3, pos: Vec3, radius: number, displayTime: number, star: StellarLightSource | null,
    cameraQuaternion: THREE.Quaternion,
  ): void {
    const observerDistance = p.length();
    const sunDir = star === null ? v3(1, 0, 0) : norm(sub(star.motion.stateAt(displayTime).r, pos));
    // 位相角は天体から見た恒星方向と観測者方向の成す角。観測者は描画原点なので -p̂ で、
    // フローティングオリジンは平行移動しかしないため、描画座標の向きは ECI の向きと一致する。
    tmpToObserver.copy(p).negate().normalize();
    const cosPhase = Math.max(-1, Math.min(1,
      sunDir.x * tmpToObserver.x + sunDir.y * tmpToObserver.y + sunDir.z * tmpToObserver.z));
    const irradiance = lambertSphereIrradiance(
      this.surface.photometry?.bondAlbedo ?? rec709Luminance(DEFAULT_ALBEDO),
      sunIrradianceAt(star, pos, displayTime), radius, observerDistance, Math.acos(cosPhase),
    );
    this.billboard.sync(
      tmpPos.copy(p).setLength(STAR_SHELL_RADIUS), POINT_SPRITE_SIZE,
      irradiance * POINT_DISPLAY_GAIN, cameraQuaternion,
    );
  }

  // 表面・積雲の殻・環・オーロラ・輝点ビルボードを解放する。
  protected disposeContents(): void {
    // group 配下と独立資源をそれぞれの所有 API で解放する。
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
