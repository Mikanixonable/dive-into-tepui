// 太陽の見た目: 戦闘視点はカメラ相対に置くビルボード、広範囲視点は実位置・実半径の球体。
import * as THREE from 'three/webgpu';
import { createSun, Sun } from '../../render/stars';
import { Ephemeris } from '../../physics/ephemeris';
import { CelestialBodyId } from '../../physics/celestial-body';
import { R_SUN } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { compressionRatio, STAR_BILLBOARD_SIZE } from '../../render/view-compression';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';

const tmpSunPos = new THREE.Vector3();

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

  // displayTime 時点の方向・位置へビルボード/実球体を同期する。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    _graphics: GraphicsSettingsData,
  ): void {
    if (!this.sun.billboard.mesh.visible && !this.sun.mesh.visible) return;
    const p = fo.RtoThreeV3(ephemeris.positionOf(this.id, displayTime));
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 実 ECI 位置に実半径で置き、ビルボードは隠す
      // (SphereView の月・木星と同じ扱い)。
      this.sun.mesh.position.copy(p);
      this.sun.mesh.scale.setScalar(this.radius);
      this.sun.mesh.visible = true;
      this.sun.billboard.hide();
    } else {
      // ビルボードは方向のみ実天体暦に従うカメラ相対の空の遠景。大きさは実半径を圧縮した値
      // ではなく、実視直径よりやや大きめの固定値。
      const k = compressionRatio(p, 'star', false);
      this.sun.billboard.sync(
        tmpSunPos.copy(p).multiplyScalar(k),
        STAR_BILLBOARD_SIZE,
        1,
        cameraSystem.activeCamera.quaternion,
      );
      this.sun.mesh.visible = false;
    }
  }

  // ビルボードと実球体メッシュを親から外し、解放する。
  dispose(): void {
    this.sun.billboard.mesh.removeFromParent();
    this.sun.mesh.removeFromParent();
    this.sun.dispose();
  }
}
