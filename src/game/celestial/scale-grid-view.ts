// 縮尺グリッド(render/scale-grid.ts)を ECI の値へつなぐ。4面が通る点はマップカメラの
// フォーカス、月軌道面・月赤道面の向きは月の運動から毎フレーム引く。
import * as THREE from 'three/webgpu';
import { ScaleGrid } from '../../render/scale-grid';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { CameraSystem } from '../camera/camera-system';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { CelestialBodies } from './celestial-bodies';
import type { Vec3 } from '../../math/vec3';
import type { ScaleGridVisibility } from '../../render/scale-grid';
import type { CelestialGridVisibility } from '../../render/celestial-grid';

// ECI の方向を描画フレームへ移す。方向は平行移動を受けないので成分をそのまま写す。
function toThreeDirection(dir: Vec3): THREE.Vector3 {
  return new THREE.Vector3(dir.x, dir.y, dir.z);
}

export class ScaleGridView {
  private readonly grid: ScaleGrid;

  // 4面ぶんの縮尺グリッドを scene へ加える。
  public constructor(scene: THREE.Scene) {
    this.grid = new ScaleGrid(scene);
  }

  // 4面ぶんの表示状態を、この1フレームのトグル・フォーカス・月の姿勢へ同期する。戦闘ビューでは
  // トグルに関わらず4面とも隠す。
  public sync(
    displayTime: number, camera: CameraFrame, cameraSystem: CameraSystem, celestialBodies: CelestialBodies,
    gridVisibility: CelestialGridVisibility,
  ): void {
    // 表示可否は、マップビューのときトグルに従う。
    const mapView = camera.mode === 'map';
    const visibility: ScaleGridVisibility = {
      ecliptic: mapView && gridVisibility.eclipticScaleGrid,
      equator: mapView && gridVisibility.equatorScaleGrid,
      moonOrbit: mapView && gridVisibility.moonOrbitScaleGrid,
      moonEquator: mapView && gridVisibility.moonEquatorScaleGrid,
    };
    // 月軌道面・月赤道面の向き。月が星系に無いか自転軸が得られなければ null。
    const moon = celestialBodies.findMotion('moon');
    const moonPole = moon === null ? null : moon.orientationAt(displayTime);
    this.grid.sync(
      visibility,
      moon instanceof OrbitingMotion ? toThreeDirection(moon.orbitNormalAt(displayTime)) : null,
      moonPole === null ? null : toThreeDirection(moonPole.axis),
      camera.floatingOrigin.RtoThreeV3(cameraSystem.mapCamera.resolvedFocus),
      camera.camera,
      cameraSystem.mapCamera.dist,
      camera.viewport,
    );
  }

  // 縮尺グリッドの表示物をシーンから外して解放する。
  public dispose(): void {
    this.grid.dispose();
  }
}
