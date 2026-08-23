// 地球本体の見た目: 位置・自転角・太陽方向・表面アニメーションを表示時刻に同期する。
import * as THREE from 'three/webgpu';
import { createEarth, Earth } from '../../render/earth';
import { Ephemeris } from '../../physics/ephemeris';
import { R_EARTH, SIDEREAL_DAY } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { CelestialView } from './celestial-view';
import type { GraphicsSettingsData } from '../../render/graphics-settings';

export class EarthView extends CelestialView {
  readonly id = 'earth' as const;
  private readonly earth: Earth = createEarth();
  // 自転初期位相 [rad]。値は外から与えられる。
  private phase0 = 0;

  // 地球メッシュをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.earth.group);
  }

  setVisible(visible: boolean): void {
    this.earth.group.visible = visible;
  }

  // 自転初期位相 [rad](セーブ用)。
  spinPhase0(): number { return this.phase0; }

  // 自転初期位相を差し替える(ロード用)。
  setSpinPhase0(phase0: number): void { this.phase0 = phase0; }

  // displayTime 時点の位置・自転角・太陽方向・表面アニメーション・地表LODへ同期する。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    graphics: GraphicsSettingsData,
  ): void {
    if (!this.earth.group.visible) return;
    const pos = ephemeris.positionOf('earth', displayTime);
    this.earth.group.position.copy(fo.RtoThreeV3(pos));
    this.earth.setRotation(this.phase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    const sd = ephemeris.sunDirFrom(pos, displayTime);
    this.earth.setSunDir(sd.x, sd.y, sd.z);
    const metersPerPixel = cameraSystem.activeCameraScale(pos);
    this.earth.setAuroraVisible(graphics.aurora);
    this.earth.syncSurfaceLod(this.lodApparentDiameterPx(2 * R_EARTH, metersPerPixel, graphics));
    this.earth.tick(displayTime);
  }

  // 地球メッシュ一式を解放する。
  dispose(): void {
    this.earth.dispose();
  }
}
