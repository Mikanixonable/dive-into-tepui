// 地球本体の見た目: 位置・自転角・太陽方向・表面アニメーションを表示時刻に同期する。
import * as THREE from 'three/webgpu';
import { createEarth, Earth } from '../../render/earth';
import { Ephemeris } from '../../physics/ephemeris';
import { SIDEREAL_DAY } from '../../physics/solar-system';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { CelestialBody } from './celestial-body';
import { CelestialLightingContext } from '../../render/celestial-lighting';

export class EarthBody extends CelestialBody {
  readonly id = 'earth' as const;
  private readonly earth: Earth = createEarth();
  private readonly phase0 = Math.random() * Math.PI * 2;

  // 地球メッシュをシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.earth.group);
  }

  // displayTime 時点の位置・自転角・太陽方向・表面アニメーションへ同期する。
  sync(
    fo: FloatingOrigin, displayTime: number, _cameraSystem: CameraSystem, ephemeris: Ephemeris,
    lighting: CelestialLightingContext,
  ): void {
    const pos = ephemeris.positionOf('earth', displayTime);
    this.earth.group.position.copy(fo.RtoThreeV3(pos));
    this.earth.setRotation(this.phase0 + (2 * Math.PI * displayTime) / SIDEREAL_DAY);
    const sd = lighting.sunDirectionFrom(pos);
    this.earth.setSunDir(sd.x, sd.y, sd.z);
    this.earth.tick(displayTime);
  }
}
