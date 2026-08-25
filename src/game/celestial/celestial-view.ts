// 天体1つぶんの見た目(メッシュ・輝点スプライト・環など)。位置・速度は持たない —
// Ephemeris が唯一の正本で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { CelestialBodyId } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { apparentSizePx } from '../../render/screen-lod';
import { SUN_IRRADIANCE_1AU, sunIrradianceAtDistance } from '../../render/pipeline/sun-light';
import { len, sub } from '../../physics/vec3';
import type { Vec3 } from '../../physics/vec3';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';

export abstract class CelestialView {
  abstract readonly id: CelestialBodyId;
  abstract build(scene: THREE.Scene): void;
  abstract setVisible(visible: boolean): void;
  abstract sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void;
  // build(scene) で登録した自分のメッシュ一式をシーンから外し、GPU 資源を解放する。
  abstract dispose(): void;

  // pos が恒星から受けている放射照度(render/pipeline/sun-light.ts の単位)。恒星を持たない
  // レジストリでは 1 天文単位ぶんを返す — 恒星光を 1 天文単位の位置へ置く EnvironmentScene の
  // 扱いと揃える。
  protected sunIrradianceAt(ephemeris: Ephemeris, pos: Vec3, displayTime: number): number {
    const starId = ephemeris.starId;
    if (starId === null) return SUN_IRRADIANCE_1AU;
    const d = len(sub(pos, ephemeris.positionOf(starId, displayTime)));
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
