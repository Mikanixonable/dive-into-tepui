// 縮尺グリッド(render/scale-grid.ts)を ECI の値へつなぐ。4面が通る点はマップカメラの
// フォーカス、月軌道面・月赤道面の向きは天体暦から毎フレーム引く。
import * as THREE from 'three/webgpu';
import { ScaleGrid } from '../../render/scale-grid';
import { Ephemeris } from '../../physics/ephemeris';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import type { Vec3 } from '../../physics/vec3';
import type { ScaleGridVisibility } from '../../render/scale-grid';
import type { CelestialGridVisibility } from '../../render/celestial-grid';

// ECI の方向を描画フレームへ移す。方向は平行移動を受けないので成分をそのまま写す
// (面の向きとしての正規化は ScaleGrid 側が行う)。
function toThreeDirection(dir: Vec3): THREE.Vector3 {
  return new THREE.Vector3(dir.x, dir.y, dir.z);
}

export class ScaleGridView {
  private readonly grid: ScaleGrid;

  constructor(scene: THREE.Scene) {
    this.grid = new ScaleGrid(scene);
  }

  // 4面ぶんの表示状態を、この1フレームのトグル・フォーカス・月の姿勢へ同期する。マップビューで
  // だけ表示するので、戦闘ビューではトグルに関わらず4面とも隠す。月がレジストリに無いか自転軸が
  // 得られないなら、その面の向きは決められないので null を渡す。
  sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris,
    gridVisibility: CelestialGridVisibility,
  ): void {
    const overviewMode = cameraSystem.overviewMode;
    const visibility: ScaleGridVisibility = {
      ecliptic: overviewMode && gridVisibility.eclipticScaleGrid,
      equator: overviewMode && gridVisibility.equatorScaleGrid,
      moonOrbit: overviewMode && gridVisibility.moonOrbitScaleGrid,
      moonEquator: overviewMode && gridVisibility.moonEquatorScaleGrid,
    };
    const moonInRegistry = 'moon' in ephemeris.registry;
    const moonPole = moonInRegistry ? ephemeris.poleAt('moon', displayTime) : null;
    this.grid.sync(
      visibility,
      moonInRegistry ? toThreeDirection(ephemeris.orbitNormalAt('moon', displayTime)) : null,
      moonPole === null ? null : toThreeDirection(moonPole.axis),
      fo.RtoThreeV3(cameraSystem.mapCamera.resolvedFocus),
      cameraSystem.activeCamera,
      cameraSystem.mapCamera.dist,
    );
  }

  dispose(): void {
    this.grid.dispose();
  }
}
