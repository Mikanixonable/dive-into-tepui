// 遠くでは輝点として見える惑星の見た目。見かけ直径が閾値未満なら実体を隠し、戦闘ビューでは
// 星殻上の輝点スプライトへ切り替える。積雲の殻・オーロラ・同期軌道リングも持てる。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { lambertSphereIrradiance } from '../../../physics/lambert-sphere';
import { STAR_SHELL_RADIUS } from '../../stars';
import { Billboard, POINT_IMAGE_ANGULAR_SIZE } from '../../billboard';
import { createCelestialSurfaceFrame, type CelestialSurfaceLike } from '../celestial-surface';
import { writeBodyFromWorld } from '../body-frame';
import { DEFAULT_ALBEDO, rec709Luminance } from '../../celestial-albedo';
import { irradianceAtDistance, SUN_IRRADIANCE_1AU } from '../../pipeline/sun-light';
import { norm, sub, v3, type Vec3 } from '../../../math/vec3';
import { SphereCelestialView } from './sphere-celestial-view';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { CameraFrame } from '../../camera/camera-frame';
import type { CloudPresentation } from '../../cloud/cloud-presentation';
import type { Aurora } from '../aurora';
import type { GeostationaryOverlay } from './geostationary-overlay';
import type { GraphicsSettingsData } from '../../graphics-settings';
import type { LineOverlay } from '../line-overlay';
import type { MarkerSlots } from '../../../game/marker/marker-slots';
import type { ShadowCumulus } from '../../pipeline/shadow/cloud-shadow-renderer';
import type { RenderStyle } from '../../render-style';
import type { RingMaterials } from '../ring';
import type { AtmosphereClouds, AtmosphereOptics } from '../../atmosphere';
import type { DefinedCelestialBody, StellarLightSource } from './celestial-view';
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

// 恒星から pos が受ける放射照度。恒星のない星系では、1AU の太陽光を使う。
function sunIrradianceAt(star: StellarLightSource | null, pos: Vec3, displayTime: number): number {
  if (star === null) return SUN_IRRADIANCE_1AU;
  const starPos = star.motion.stateAt(displayTime).r;
  const distance = Math.hypot(pos.x - starPos.x, pos.y - starPos.y, pos.z - starPos.z);
  return distance <= 0 ? SUN_IRRADIANCE_1AU : irradianceAtDistance(star.stellarLight.radiantIntensity, distance);
}

export class PointCelestialView extends SphereCelestialView {
  // 輝点スプライト。build で作る(グローテクスチャの生成が DOM を要する)。
  private billboard!: Billboard;
  // cumulusShadowAt が呼ばれるたびに書き換えて返す、描画座標から天体固定の向きへの回転。
  private readonly bodyFromWorld = new THREE.Matrix4();
  // 表面へ渡すフレーム番号。
  private surfaceFrame = 0;

  // surface はマップビューで見せる実体。surfaceMarkings は模式図でだけ見せる天体固有の表面
  // ライン、auroras は極を囲むカーテン(層ごとに1枚)、mapOverlay はマップ専用の同期軌道リング、
  // cumulus は地表の上に浮く不透明な積雲の殻。持たない天体では null / 空。
  public constructor(
    surface: CelestialSurfaceLike,
    optics: AtmosphereOptics | null = null,
    surfaceMarkings: LineOverlay | null = null,
    private readonly auroras: readonly Aurora[] = [],
    private readonly mapOverlay: GeostationaryOverlay | null = null,
    private readonly cumulus: CloudPresentation | null = null,
  ) { super(surface, optics, surfaceMarkings); }

  // 本体に加えて、積雲の殻・オーロラ・輝点ビルボード・同期軌道リングをシーンへ一度だけ登録する。
  public override build(motion: CelestialMotion, scene: THREE.Scene, ringMaterials: RingMaterials): void {
    // 輝点は単色(SPEC/RENDERING.md「画面上の大きさに基づく詳細度」節)。
    this.billboard = new Billboard(0xffffff, -9);
    super.build(motion, scene, ringMaterials);
    this.cumulus?.addTo(this.shapeGroup);
    for (const aurora of this.auroras) this.group.add(aurora.mesh);
    scene.add(this.billboard.mesh);
    this.mapOverlay?.build(scene);
  }

  // 本体ごと非表示のフレームは、group の外に置いた輝点も隠す。
  protected override syncHidden(): void {
    this.billboard.hide();
  }

  // 実体を畳んだフレームは積雲の殻とオーロラも隠し、戦闘ビューなら輝点だけを置く。
  protected override syncUnresolved(
    motion: CelestialMotion, pos: Vec3, displayTime: number, camera: CameraFrame,
    star: StellarLightSource | null,
  ): void {
    this.cumulus?.setCloudsVisible(false);
    for (const aurora of this.auroras) aurora.mesh.visible = false;
    if (camera.mode === 'map') {
      this.billboard.hide();
    } else {
      this.syncBillboard(
        camera.floatingOrigin.RtoThreeV3(pos), pos, motion.def.radius, displayTime, star,
        camera.camera.quaternion);
    }
  }

  // 実体を描くフレームは、積雲の殻・オーロラ・表面のフレーム値を同期して輝点を隠す。
  protected override syncResolved(
    apparentDiameterPx: number, displayTime: number, camera: CameraFrame,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    // 雲。
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
    // オーロラと表面のフレーム値。
    this.syncAuroras(displayTime, graphics.aurora);
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
  }

  // 影パスへ渡す積雲の殻。本体と雲殻を描いているフレームでだけ返す。返す bodyFromWorld は
  // 使い回しの実体で、次の呼び出しで書き換わる。
  public override cumulusShadowAt(
    motion: DefinedCelestialBody, fo: FloatingOrigin, displayTime: number,
  ): ShadowCumulus | null {
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

  // 大気の散乱へ立てる雲。本体と雲を描いているフレームでだけ返す。姿勢の行列は毎回新しく作る
  // — 描画時まで読まれるので、cumulusShadowAt の使い回しの実体では同期中に書き換わる。
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
  public override syncMapOverlay(
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

  // 星殻上に、描画座標 p の方向だけを反映した輝点を置く。明るさは「いま観測者へ届く光の量」
  // — ランバート球として引いた放射照度に、点光源の表示応答を掛けたもの。
  private syncBillboard(
    p: THREE.Vector3, pos: Vec3, radius: number, displayTime: number, star: StellarLightSource | null,
    cameraQuaternion: THREE.Quaternion,
  ): void {
    const observerDistance = p.length();
    const sunDir = star === null ? v3(1, 0, 0) : norm(sub(star.motion.stateAt(displayTime).r, pos));
    // 位相角は天体から見た恒星方向と観測者方向(-p̂)の成す角。描画座標は ECI の平行移動なので、
    // ECI の sunDir と描画座標の p̂ の向きを混ぜてよい。
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

  // 本体に加えて、積雲の殻・オーロラ・同期軌道リング・輝点ビルボードを解放する。
  protected override disposeContents(): void {
    super.disposeContents();
    this.cumulus?.dispose();
    for (const aurora of this.auroras) aurora.dispose();
    this.mapOverlay?.dispose();
    this.billboard.mesh.removeFromParent();
    this.billboard.dispose();
  }
}
