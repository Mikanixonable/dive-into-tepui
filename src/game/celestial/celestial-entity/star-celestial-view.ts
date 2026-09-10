// 恒星の見た目: 実位置・実半径の自発光球体(遠くて球として描けないときは点像)と、
// 模式図で代わりに出す輪郭円。
import * as THREE from 'three/webgpu';
import type { CelestialMotion } from '../../../physics/celestial-motion';
import { createStarSphere, type StarSphere } from '../../../render/star-sphere';
import { createOutlineCircle, OutlineCircle } from '../../../render/outline-circle';
import type { CameraSystem } from '../../camera/camera-system';
import type { FloatingOrigin } from '../../camera/floating-origin';
import { apparentSizePx } from '../../../math/projection';
import type { GraphicsSettingsData } from '../../../render/graphics-settings';
import type { RenderStyle } from '../../../render/render-style';
import type { RingMaterials } from '../../../render/ring';
import { CelestialView, type StellarLight, type StellarLightSource } from './celestial-view';

export class StarCelestialView extends CelestialView {
  private star: StarSphere | null = null;
  // 模式図で恒星の代わりに出す、実位置・実半径の輪郭円。球のシルエットなので毎フレーム
  // カメラへ正対させる。
  private readonly outline: OutlineCircle = createOutlineCircle();

  // surfaceColor は恒星面の自発光色。
  public constructor(
    private readonly surfaceColor: string | number,
    private readonly light: StellarLight,
  ) { super(); }

  public override get stellarLight(): StellarLight { return this.light; }

  // 実球体・点像・輪郭円をシーンへ一度だけ登録する。
  public build(
    motion: CelestialMotion, scene: THREE.Scene, _ringMaterials: RingMaterials,
  ): void {
    this.star = createStarSphere(
      this.surfaceColor,
      surfaceRadianceOf(this.light.radiantIntensity, motion.def.radius),
    );
    this.star.addTo(scene);
    scene.add(this.outline.line);
  }

  // displayTime 時点の実位置へ恒星を置く。
  public sync(
    motion: CelestialMotion, fo: FloatingOrigin, displayTime: number,
    cameraSystem: CameraSystem, _star: StellarLightSource | null,
    graphics: GraphicsSettingsData, style: RenderStyle, visible: boolean,
  ): void {
    const star = this.star;
    if (star === null) return;
    star.setVisible(visible);
    this.outline.line.visible = visible;
    if (!visible) return;
    const pos = motion.stateAt(displayTime).r;
    const p = fo.RtoThreeV3(pos);
    const radius = motion.def.radius;
    if (style === 'schematic') {
      star.hide();
      // 円は姿勢を持たないので、球のシルエットとして見せるには毎フレームカメラへ正対させる。
      this.outline.line.visible = true;
      this.outline.line.position.copy(p);
      this.outline.line.scale.setScalar(radius);
      this.outline.line.quaternion.copy(cameraSystem.activeCamera.quaternion);
      return;
    }
    this.outline.line.visible = false;
    // マップビューでは実球体だけを使う。**点像を置く星殻がカメラの近平面より手前にあるとは
    // 限らない** — 引いたマップビューでは近平面が星殻より遠く、置いても写らない。
    if (cameraSystem.view === 'map') {
      star.syncSphere(p, radius);
      return;
    }
    star.sync(
      p, radius,
      apparentSizePx(2 * radius, cameraSystem.activeCameraRadialScale(pos)) * graphics.lodBias,
      cameraSystem.activeCamera.quaternion,
    );
  }

  // 恒星の見た目と輪郭円を親から外し、解放する。
  protected disposeContents(): void {
    this.outline.line.removeFromParent();
    this.star?.dispose();
    this.outline.dispose();
  }
}

// 放射強度 I の恒星の、半径 radius の面の輝度。距離 d での放射照度 I/d² は恒星円盤が張る
// 立体角 π(radius/d)² を通して届くので、面の輝度は I/(π·radius²) になる。
function surfaceRadianceOf(radiantIntensity: number, radius: number): number {
  return radiantIntensity / (Math.PI * radius * radius);
}
