// 天体1体。運動(CelestialMotion)と表示名・表示クラスを持ち、見た目(メッシュ・輝点スプライト・
// 環など)をその運動へ同期する。位置・姿勢の正本は motion で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { CelestialBodyDef, CelestialMotion } from '../../physics/celestial-motion';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { apparentSizePx } from '../../math/projection';
import { SUN_IRRADIANCE_1AU, sunIrradianceAtDistance } from '../../render/pipeline/sun-light';
import { len, sub } from '../../math/vec3';
import type { AtmosphereOptics } from '../../render/atmosphere';
import type { Albedo } from '../../render/celestial-albedo';
import type { BodyClass } from './celestial-entity-def';
import type { Vec3 } from '../../math/vec3';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { SunLight } from '../../render/pipeline/sun-light';
import type { SunOcclusion } from '../../render/pipeline/sun-occlusion';
import type { RenderStyle } from '../../render/render-style';

export abstract class CelestialEntity {
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
  abstract dispose(): void;

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
