// 天体1つぶんの見た目(メッシュ・表示距離圧縮など)。位置・速度は持たない —
// Ephemeris が唯一の正本で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { AttractorId } from '../../physics/attractor';
import { Ephemeris } from '../../physics/ephemeris';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';

export abstract class CelestialBody {
  abstract readonly id: AttractorId;
  abstract build(scene: THREE.Scene): void;
  abstract setVisible(visible: boolean): void;
  abstract sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void;
}
