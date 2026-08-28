// 太陽の見た目: 実位置・実半径の自発光球体(遠くて球として描けないときは点像)と、
// 模式図で代わりに出す輪郭円。
import * as THREE from 'three/webgpu';
import { createSun, type Sun as SunMesh } from '../../render/stars';
import { createOutlineCircle, OutlineCircle } from '../../render/outline-circle';
import { CelestialMotion, StarMotion } from '../../physics/celestial-motion';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { CelestialEntity } from './celestial-entity';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';

export class Sun extends CelestialEntity {
  private readonly sun: SunMesh = createSun();
  // 模式図で太陽の代わりに出す、実位置・実半径の輪郭円。球のシルエットなので毎フレーム
  // カメラへ正対させる。
  private readonly outline: OutlineCircle = createOutlineCircle();
  // 広範囲視点での実球体半径 [m]。
  private readonly radius: number;

  constructor(motion: StarMotion, name: string) {
    super(motion, name, 'star');
    this.radius = motion.def.radius;
  }

  // 実球体・点像・輪郭円をシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    this.sun.addTo(scene);
    scene.add(this.outline.line);
  }

  // 恒星の見た目と輪郭円をまとめて表示/非表示にする。
  setVisible(visible: boolean): void {
    this.sun.setVisible(visible);
    this.outline.line.visible = visible;
  }

  // displayTime 時点の実位置へ恒星を置く。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, _star: CelestialMotion | null,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.sun.visible && !this.outline.line.visible) return;
    const pos = this.motion.stateAt(displayTime).r;
    const p = fo.RtoThreeV3(pos);
    if (style === 'schematic') {
      this.sun.hide();
      // 円は姿勢を持たないので、球のシルエットとして見せるには毎フレームカメラへ正対させる。
      this.outline.line.visible = true;
      this.outline.line.position.copy(p);
      this.outline.line.scale.setScalar(this.radius);
      this.outline.line.quaternion.copy(cameraSystem.activeCamera.quaternion);
      return;
    }
    this.outline.line.visible = false;
    // マップビューでは実球体だけを使う。**点像を置く星殻がカメラの近平面より手前にあるとは
    // 限らない** — 引いたマップビューでは近平面が星殻より遠く、置いても写らない。
    if (cameraSystem.overviewMode) {
      this.sun.syncSphere(p, this.radius);
      return;
    }
    this.sun.sync(
      p, this.radius,
      this.lodApparentDiameterPx(2 * this.radius, cameraSystem.activeCameraScale(pos), graphics),
      cameraSystem.activeCamera.quaternion,
    );
  }

  // 恒星の見た目と輪郭円を親から外し、解放する。
  dispose(): void {
    this.outline.line.removeFromParent();
    this.sun.dispose();
    this.outline.dispose();
  }
}
