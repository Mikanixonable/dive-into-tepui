// 天体1つぶんの見た目(メッシュ・表示距離圧縮など)。位置・速度は持たない —
// Ephemeris が唯一の正本で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { CelestialBodyId } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import type { GraphicsSettings } from '../../render/graphics-settings';

export abstract class CelestialView {
  abstract readonly id: CelestialBodyId;
  abstract build(scene: THREE.Scene): void;
  abstract setVisible(visible: boolean): void;
  abstract sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    graphics: GraphicsSettings,
  ): void;
  // build(scene) で登録した自分のメッシュ一式をシーンから外し、GPU 資源を解放する。
  abstract dispose(): void;
}
