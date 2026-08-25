// 太陽の見た目: 実位置・実半径の自発光球体と、戦闘視点でその周りへ重ねるグロー。
import * as THREE from 'three/webgpu';
import { createSun, Sun, STAR_GLOW_SIZE_RATIO, SUN_GLOW_RADIANCE } from '../../render/stars';
import { createOutlineCircle, OutlineCircle } from '../../render/outline-circle';
import { Ephemeris } from '../../physics/ephemeris';
import { CelestialBodyId } from '../../physics/celestial-body';
import { R_SUN } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
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

  // ビルボードと実球体メッシュをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.sun.billboard.mesh);
    scene.add(this.sun.mesh);
    scene.add(this.outline.line);
  }

  // 球体・グロー・輪郭円をまとめて表示/非表示にする。
  setVisible(visible: boolean): void {
    this.sun.billboard.mesh.visible = visible;
    this.sun.mesh.visible = visible;
    this.outline.line.visible = visible;
  }

  // displayTime 時点の実位置へ球体を置き、戦闘視点でだけグローを重ねる。グローは太陽へ
  // 十分に近づけるマップビューでは画面を埋め尽くしてしまうので出さない。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    _graphics: GraphicsSettingsData, style: RenderStyle,
  ): void {
    if (!this.sun.billboard.mesh.visible && !this.sun.mesh.visible && !this.outline.line.visible) return;
    const p = fo.RtoThreeV3(ephemeris.positionOf(this.id, displayTime));
    const schematic = style === 'schematic';
    this.sun.mesh.position.copy(p);
    this.sun.mesh.scale.setScalar(this.radius);
    this.sun.mesh.visible = !schematic;
    if (schematic) {
      // 円は姿勢を持たないので、球のシルエットとして見せるには毎フレームカメラへ正対させる。
      this.sun.billboard.hide();
      this.outline.line.visible = true;
      this.outline.line.position.copy(p);
      this.outline.line.scale.setScalar(this.radius);
      this.outline.line.quaternion.copy(cameraSystem.activeCamera.quaternion);
      return;
    }
    this.outline.line.visible = false;
    if (cameraSystem.overviewMode) {
      this.sun.billboard.hide();
    } else {
      this.sun.billboard.sync(
        p,
        this.radius * STAR_GLOW_SIZE_RATIO,
        SUN_GLOW_RADIANCE,
        cameraSystem.activeCamera.quaternion,
      );
    }
  }

  // ビルボード・実球体メッシュ・輪郭円を親から外し、解放する。
  dispose(): void {
    this.sun.billboard.mesh.removeFromParent();
    this.sun.mesh.removeFromParent();
    this.outline.line.removeFromParent();
    this.sun.dispose();
    this.outline.dispose();
  }
}
