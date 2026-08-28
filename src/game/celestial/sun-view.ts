// 太陽の見た目: 実位置・実半径の自発光球体(遠くて球として描けないときは点像)と、
// 模式図で代わりに出す輪郭円。
import * as THREE from 'three/webgpu';
import { createSun, Sun } from '../../render/stars';
import { createOutlineCircle, OutlineCircle } from '../../render/outline-circle';
import { Ephemeris } from '../../physics/ephemeris';
import { CelestialBodyId } from '../../physics/celestial-body';
import { R_SUN } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { RenderStyle } from '../../render/render-style';

export class SunView extends CelestialView {
  readonly id: CelestialBodyId;
  private readonly sun: Sun = createSun();
  // 模式図で太陽の代わりに出す、実位置・実半径の輪郭円。球のシルエットなので毎フレーム
  // カメラへ正対させる。
  private readonly outline: OutlineCircle = createOutlineCircle();

  // id は恒星として振る舞う天体の id、radius は広範囲視点での実球体半径 [m]。
  constructor(id: CelestialBodyId = 'sun', private readonly radius: number = R_SUN) {
    super();
    this.id = id;
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
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.sun.visible && !this.outline.line.visible) return;
    const pos = ephemeris.positionOf(this.id, displayTime);
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
