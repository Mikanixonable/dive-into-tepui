// 太陽の見た目: 実位置・実半径の自発光球体と、戦闘視点でその周りへ重ねるグロー。
import * as THREE from 'three/webgpu';
import { createSun, Sun, STAR_GLOW_SIZE_RATIO } from '../../render/stars';
import { Ephemeris } from '../../physics/ephemeris';
import { CelestialBodyId } from '../../physics/celestial-body';
import { R_SUN } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';

export class SunView extends CelestialView {
  readonly id: CelestialBodyId;
  private readonly sun: Sun = createSun();

  // id は恒星として振る舞う天体の id、radius は広範囲視点での実球体半径 [m]。
  constructor(id: CelestialBodyId = 'sun', private readonly radius: number = R_SUN) {
    super();
    this.id = id;
  }

  // ビルボードと実球体メッシュをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.sun.billboard.mesh);
    scene.add(this.sun.mesh);
  }

  setVisible(visible: boolean): void {
    this.sun.billboard.mesh.visible = visible;
    this.sun.mesh.visible = visible;
  }

  // displayTime 時点の実位置へ球体を置き、戦闘視点でだけグローを重ねる。グローは太陽へ
  // 十分に近づけるマップビューでは画面を埋め尽くしてしまうので出さない。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    _graphics: GraphicsSettingsData,
  ): void {
    if (!this.sun.billboard.mesh.visible && !this.sun.mesh.visible) return;
    const p = fo.RtoThreeV3(ephemeris.positionOf(this.id, displayTime));
    this.sun.mesh.position.copy(p);
    this.sun.mesh.scale.setScalar(this.radius);
    this.sun.mesh.visible = true;
    if (cameraSystem.overviewMode) {
      this.sun.billboard.hide();
    } else {
      this.sun.billboard.sync(
        p,
        this.radius * STAR_GLOW_SIZE_RATIO,
        1,
        cameraSystem.activeCamera.quaternion,
      );
    }
  }

  // ビルボードと実球体メッシュを親から外し、解放する。
  dispose(): void {
    this.sun.billboard.mesh.removeFromParent();
    this.sun.mesh.removeFromParent();
    this.sun.dispose();
  }
}
