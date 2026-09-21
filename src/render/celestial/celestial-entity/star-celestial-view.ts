// 恒星1体の表示。恒星の見た目を、表示時刻の実位置・実半径へ表示スタイルで置く。
import type * as THREE from 'three/webgpu';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { isStar } from '../../../physics/celestial-body-def';
import { createStarSphere, type StarSphere } from '../star-sphere';
import type { CameraFrame } from '../../camera/camera-frame';
import { apparentSizePx } from '../../../math/projection';
import type { GraphicsSettingsData } from '../../graphics-settings';
import type { RenderStyle } from '../../render-style';
import type { RingMaterials } from '../ring';
import { scaledRadiantIntensity } from '../../pipeline/sun-light';
import { CelestialView, type StellarLight, type StellarLightSource } from './celestial-view';

export class StarCelestialView extends CelestialView {
  private star: StarSphere | null = null;

  // surfaceColor は恒星面の自発光色。
  public constructor(
    private readonly surfaceColor: string | number,
    private readonly light: StellarLight,
  ) { super(); }

  public override get stellarLight(): StellarLight { return this.light; }

  // 恒星の見た目をシーンへ一度だけ登録する。motion は恒星でなければならない。
  public build(
    motion: CelestialMotion, scene: THREE.Scene, _ringMaterials: RingMaterials,
  ): void {
    if (!isStar(motion)) throw new Error(`StarCelestialView: 恒星でない天体には付けられない: ${motion.id}`);
    this.star = createStarSphere(
      this.surfaceColor,
      surfaceRadianceOf(scaledRadiantIntensity(motion.def.radiantIntensity), motion.def.radius),
    );
    this.star.addTo(scene);
  }

  // displayTime 時点の実位置へ、style の見た目で恒星を置く。
  public sync(
    motion: CelestialMotion, displayTime: number, _nowMs: number, camera: CameraFrame,
    _star: StellarLightSource | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (this.star === null) return;
    const pos = motion.stateAt(displayTime).r;
    const radius = motion.def.radius;
    this.star.sync(
      camera.floatingOrigin.RtoThreeV3(pos), radius,
      apparentSizePx(2 * radius, camera.radialScale(pos)) * graphics.lodBias,
      camera.camera.quaternion, style,
    );
  }

  // 恒星の見た目を親から外し、解放する。
  protected disposeContents(): void {
    this.star?.dispose();
  }
}

// 放射強度 I の恒星の、半径 radius の面の輝度。距離 d での放射照度 I/d² は恒星円盤が張る
// 立体角 π(radius/d)² を通して届くので、面の輝度は I/(π·radius²) になる。
export function surfaceRadianceOf(radiantIntensity: number, radius: number): number {
  return radiantIntensity / (Math.PI * radius * radius);
}
