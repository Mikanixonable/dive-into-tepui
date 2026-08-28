// 天体1体。運動(CelestialMotion)と表示名・表示クラスを持ち、見た目(メッシュ・輝点スプライト・
// 環など)をその運動へ同期する。位置・姿勢の正本は motion で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { CelestialBodyDef, CelestialMotion } from '../../physics/celestial-motion';
import { CelestialBody, orbitalElementsOf } from '../../physics/celestial-body';
import { OrbitalElements } from '../../physics/elements';
import { OrbitLine } from '../lines/orbit-line';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import type { MarkerManager } from '../marker/marker-manager';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { apparentSizePx } from '../../math/projection';
import { SUN_IRRADIANCE_1AU, sunIrradianceAtDistance } from '../../render/pipeline/sun-light';
import { len, sub, v3 } from '../../math/vec3';
import type { AtmosphereOptics } from '../../render/atmosphere';
import type { Albedo } from '../../render/celestial-albedo';
import type { BodyClass } from './celestial-entity-def';
import type { Vec3 } from '../../math/vec3';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { SunLight } from '../../render/pipeline/sun-light';
import type { SunOcclusion } from '../../render/pipeline/sun-occlusion';
import type { RenderStyle } from '../../render/render-style';

// 公転天体の参照軌道線の色: 衛星は月軌道線の色、惑星は木星軌道線の色を踏襲し、
// 同じ種別の天体はすべて同じ色で引く。
const SATELLITE_REFERENCE_LINE_COLOR = 0xaab3c0;
const PLANET_REFERENCE_LINE_COLOR = 0xffffff;

export abstract class CelestialEntity {
  // マップ専用の参照軌道線(衛星は親惑星中心、惑星は主星中心)。実体は個体が持ち、
  // 出す/消す・濃さの判断は所有者(CelestialSystem)が sync/remove の呼び分けで行う。
  referenceLine: OrbitLine | null = null;

  // atmosphereOptics は大気の見えの光学パラメータ(大気を持たない・描かない天体では null)。
  protected constructor(
    readonly motion: CelestialMotion,
    readonly name: string,
    readonly bodyClass: BodyClass,
    readonly atmosphereOptics: AtmosphereOptics | null,
  ) {}

  // この天体を光源として扱うときの色つきアルベド(Rec.709 輝度 = ボンドアルベド)。
  // 自発光の恒星と、測光を持たない表面では null。
  abstract get lightSourceAlbedo(): Albedo | null;

  // 円筒図法の実写テクスチャの URL。単色球・恒星では null。
  abstract get surfaceTextureUrl(): string | null;

  get id(): string {
    return this.motion.id;
  }

  get def(): CelestialBodyDef {
    return this.motion.def;
  }

  // 自分のメッシュ一式を組んでシーンへ登録する。sunOcclusion と sunLight は環が直射散乱の
  // 遮蔽と明るさを引くために要る — 環を持たない天体でも、持ちうる形として受ける。
  abstract build(scene: THREE.Scene, sunOcclusion: SunOcclusion, sunLight: SunLight): void;
  abstract setVisible(visible: boolean): void;
  // star はこの星系の恒星の運動。恒星を持たない星系では null。
  abstract sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, star: CelestialMotion | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void;
  // build(scene) で登録した自分のメッシュ一式をシーンから外し、GPU 資源を解放する。
  // 参照軌道線は所有者が removeReferenceLine で別途解放する。
  abstract dispose(): void;

  // 公転天体の接触軌道要素(表示専用)。衛星は親惑星中心、惑星は主星中心 — 中心天体自身も
  // ECI 上を動くので、固定 CelestialBody ではなくその時刻の状態を毎回引いて組む。恒星は null。
  referenceElementsAt(t: number): OrbitalElements | null {
    const centerMotion = this.motion.primary;
    if (centerMotion === null) return null;
    const centerDef = centerMotion.def;
    const center: CelestialBody = {
      id: centerMotion.id, mu: centerDef.mu, radius: centerDef.radius, state: centerMotion.stateAt(t),
      accel: v3(), degree2: null, atmosphere: null, isStar: centerMotion.kind === 'star',
    };
    return orbitalElementsOf(this.motion.stateAt(t), center);
  }

  // 参照軌道線を表示時刻の接触軌道要素と濃さへ同期する(実体が無ければ生成して scene へ登録)。
  syncReferenceLine(scene: THREE.Scene, simTime: number, fo: FloatingOrigin, camera: THREE.Camera, opacity: number): void {
    if (this.referenceLine === null) {
      const color = this.motion.kind === 'satellite' ? SATELLITE_REFERENCE_LINE_COLOR : PLANET_REFERENCE_LINE_COLOR;
      this.referenceLine = new OrbitLine({ color, opacity, renderOrder: LINE_RENDER_ORDER.reference });
      scene.add(this.referenceLine.line);
    }
    this.referenceLine.sync(this.referenceElementsAt(simTime), fo, camera);
    this.referenceLine.setOpacity(opacity);
  }

  // 参照軌道線を実体ごと解放する。非表示の間も頂点バッファを残さないため。
  removeReferenceLine(): void {
    if (this.referenceLine === null) return;
    this.referenceLine.line.removeFromParent();
    this.referenceLine.dispose();
    this.referenceLine = null;
  }

  // マップ専用の付随表示(静止軌道リングなど)のフック。既定では何も持たない。
  syncMapOverlay(
    _fo: FloatingOrigin, _displayTime: number, _cameraSystem: CameraSystem,
    _markerManager: MarkerManager | null, _celestialBodies: readonly CelestialBody[], _visible: boolean,
  ): void {}

  // pos が恒星から受けている放射照度(render/pipeline/sun-light.ts の単位)。恒星を持たない
  // 星系では 1 天文単位ぶんを返す — 恒星光を 1 天文単位の位置へ置く CelestialSystem の
  // 扱いと揃える。
  protected sunIrradianceAt(star: CelestialMotion | null, pos: Vec3, displayTime: number): number {
    if (star === null) return SUN_IRRADIANCE_1AU;
    const d = len(sub(pos, star.stateAt(displayTime).r));
    if (d <= 0) return SUN_IRRADIANCE_1AU;
    return sunIrradianceAtDistance(d);
  }

  // LOD 段の選択と球体表示の閾値判定が通る見かけ直径 [px]。詳細度の設定はここで掛かる。
  protected lodApparentDiameterPx(
    diameterMeters: number, metersPerPixel: number, graphics: GraphicsSettingsData,
  ): number {
    return apparentSizePx(diameterMeters, metersPerPixel) * graphics.lodBias;
  }
}
