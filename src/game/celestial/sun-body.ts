// 太陽の見た目: 戦闘視点はカメラ相対に置くビルボード、広範囲視点は実位置・実半径の球体。
// どちらも地心方向を向く DirectionalLight は共通で駆動する。
import * as THREE from 'three/webgpu';
import { createSun, Sun, SUN_DISTANCE, SUN_VISUAL_SIZE } from '../../render/stars';
import { Ephemeris } from '../../physics/ephemeris';
import { norm, sub } from '../../physics/vec3';
import { R_SUN } from '../../physics/solar-system';
import * as C from '../const';
import { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { CelestialBody } from './celestial-body';

const tmpSunPos = new THREE.Vector3();

export class SunBody extends CelestialBody {
  readonly id = 'sun' as const;
  private readonly sun: Sun = createSun();
  private readonly sunLight = new THREE.DirectionalLight(0xfff4e0, C.SUN_INTENSITY);
  private lit = 1;

  // ビルボード・実球体メッシュ・DirectionalLight をシーンへ一度だけ登録する。
  build(scene: THREE.Scene): void {
    scene.add(this.sun.billboard.mesh);
    scene.add(this.sun.mesh);
    scene.add(this.sunLight);
  }

  // 自機位置の日照率(円柱影近似)を反映する。物理的に正確な値ではない表示上の演出なので、
  // 天体暦を持たないこのクラスへは呼び出し側(EnvironmentScene)が計算して渡す。
  setSunlit(lit: number): void {
    this.lit = lit;
  }

  // displayTime 時点の方向・位置へビルボード/実球体と DirectionalLight を同期する。
  sync(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, ephemeris: Ephemeris): void {
    const sunPos = ephemeris.positionOf('sun', displayTime);
    if (cameraSystem.overviewMode) {
      // 広範囲視点は実スケール: 実 ECI 位置に実半径で置き、ビルボードは隠す
      // (SphereBody の月・木星と同じ扱い)。
      this.sun.mesh.position.copy(fo.RtoThreeV3(sunPos));
      this.sun.mesh.scale.setScalar(R_SUN);
      this.sun.mesh.visible = true;
      this.sun.billboard.hide();
    } else {
      const cam = cameraSystem.activeCamera;
      // ビルボードは方向のみ実天体暦に従うカメラ相対の空の遠景。地心方向ではなく
      // 「カメラから見た太陽の方向」を使う: 広範囲視点はカメラが地球から最大 4.5e9 m
      // 離れるため、地心方向で置くと視差ぶん(最大 1.7°)実位置からずれ、実 ECI 位置に
      // 置かれる太陽ラベルと像が合わなくなる。
      const sdCam = norm(sub(sunPos, cameraSystem.activeCameraPos));
      this.sun.billboard.sync(
        tmpSunPos.set(
          cam.position.x + sdCam.x * SUN_DISTANCE,
          cam.position.y + sdCam.y * SUN_DISTANCE,
          cam.position.z + sdCam.z * SUN_DISTANCE,
        ),
        SUN_VISUAL_SIZE,
        1,
        cam.quaternion,
      );
      this.sun.mesh.visible = false;
    }
    const sd = ephemeris.sunDirAt(displayTime);
    this.sunLight.position.set(sd.x * 1e5, sd.y * 1e5, sd.z * 1e5);
    this.sunLight.intensity = C.SUN_INTENSITY * (C.SHADOW_MIN_SUN + (1 - C.SHADOW_MIN_SUN) * this.lit);
  }
}
