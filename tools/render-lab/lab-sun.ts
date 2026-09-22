// 描画テスト環境の恒星。観察のつまみが決める位置へ光源を置き、光源と同じ位置・半径へ恒星の見た目を
// 描く。光源としての位置・放射強度と、そこから届く放射照度を答える。
import * as THREE from 'three/webgpu';
import { R_SUN, SUN, SUN_SURFACE_COLOR } from '../../src/game/celestial/solar-system/sun';
import { createStarSphere } from '../../src/render/celestial/star-sphere';
import { surfaceRadianceOf } from '../../src/render/celestial/celestial-entity/star-celestial-view';
import { irradianceAtDistance, scaledRadiantIntensity } from '../../src/render/pipeline/sun-light';
import { apparentSizePx, metersPerPixelAtDepth } from '../../src/math/projection';
import { AU } from '../../src/physics/astronomical-unit';
import { VIEW_HEIGHT } from './lab-case';
import { directionFromAngles, type LabViewAngles } from './view-angles';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { RenderStyle } from '../../src/render/render-style';

// 観察の向き angles が置く恒星までの距離 [m]。
export function sunDistanceOf(angles: LabViewAngles): number {
  return AU * 10 ** angles.sunDistanceLogAu;
}

// 恒星までの距離 [m] と画角 [deg] に対する、画面上での太陽の見かけ直径 [px]。**LOD の閾値判定と
// 同じ換算を通す** — つまみの脇に出る数と、球/点像の切り替わる距離が食い違ってはならない。
export function sunDiameterPx(distance: number, fovDeg: number): number {
  return apparentSizePx(2 * R_SUN, metersPerPixelAtDepth(fovDeg, distance, VIEW_HEIGHT));
}

export class LabSun {
  // 光源の位置(描画座標)。sync がその場で書き換える。
  public readonly position = new THREE.Vector3();
  public readonly intensity = scaledRadiantIntensity(SUN.radiantIntensity);
  private readonly star = createStarSphere(SUN_SURFACE_COLOR, surfaceRadianceOf(this.intensity, R_SUN));

  // 恒星の見た目をシーンへ一度だけ登録する。
  public addTo(scene: THREE.Scene): void {
    this.star.addTo(scene);
  }

  // 観察の向き angles の置き方へ光源を置き直し、恒星の見た目を同じ位置・半径へ、camera の画角と
  // graphics の詳細度で決まる見かけ直径と表示スタイル style で置く。**見た目だけを動かさない** —
  // 明るさの根拠と光点の位置が食い違うと、ちらつきの出どころを読み違える。
  public sync(
    angles: LabViewAngles, camera: THREE.PerspectiveCamera, graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    const distance = sunDistanceOf(angles);
    directionFromAngles(angles.sunAzimuthDeg, angles.sunElevationDeg, this.position).multiplyScalar(distance);
    this.star.sync(
      this.position, R_SUN, sunDiameterPx(distance, camera.fov) * graphics.lodBias, camera.quaternion, style,
    );
  }

  // 描画座標の点 point が受ける放射照度。
  public irradianceAt(point: THREE.Vector3): number {
    return irradianceAtDistance(this.intensity, this.position.distanceTo(point));
  }
}
