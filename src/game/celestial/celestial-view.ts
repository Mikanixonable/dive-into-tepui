// 天体1つぶんの見た目(メッシュ・表示距離圧縮など)。位置・速度は持たない —
// Ephemeris が唯一の正本で、sync のたびにそこから引く。
import * as THREE from 'three/webgpu';
import { CelestialBodyId } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { apparentSizePx } from '../../render/screen-lod';
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

  // LOD 段の選択と球体表示の閾値判定が通る見かけ直径 [px]。詳細度の設定はここで掛かる。
  protected lodApparentDiameterPx(
    diameterMeters: number, metersPerPixel: number, graphics: GraphicsSettings,
  ): number {
    return apparentSizePx(diameterMeters, metersPerPixel) * graphics.current.lodBias;
  }
}
