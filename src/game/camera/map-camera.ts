// 軌道計画モード(マップモード)のカメラと視点操作: マップ地球中心カメラ・
// 太陽回転系表示・未来スライダー。「マップモード中の視点」の担当で、mapMode 中のみ
// 意味を持つ。フォーカス対象(文字列 focus とその解決)は map-mode-system.ts が持ち、
// 解決済みの相対位置(focusRel)を引数で渡す — このクラスはラベルや focus という
// 文字列を一切知らない。
// game.ts を import しない — 依存はコンストラクタ注入(hud)・引数(Vec3/project等)のみ。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../../hud/hud';
import { MouseDelta } from '../input';

export class MapCamera {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0.7;
  pitch = 0.45;
  dist = 4.5e7;
  // Stored in the floating-origin render frame. It is applied to both the
  // camera and its target, so middle-drag is a true parallel translation.
  readonly pan = new THREE.Vector3();
  frameRotating = false;
  sliderT = 0; // 0..1(0 でゴーストマーカー非表示)

  constructor(private readonly hud: Hud) {
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      1e4,
      C.MAP_CAMERA_FAR,
    );
  }

  reset(): void {
    this.yaw = 0.7;
    this.pitch = 0.45;
    this.dist = 4.5e7;
    this.pan.set(0, 0, 0);
    this.hud.hint('マップ視点をリセット');
  }

  // 毎フレーム、マップカメラの位置・向きをマウス/矢印キー操作から更新する。
  // focusRel: 注視点(地球中心 or フォーカス対象)のフローティングオリジン相対位置。
  // どの対象を見るかの解決は呼び出し側(map-mode-system.ts)の責務。
  // sunAz: 太陽回転系表示の追従角。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    focusRel: Vec3,
    sunAz: number,
  ): void {
    // 戦闘ビューは yaw -= dx*0.005 なので、符号を反転させて左右の回転方向を揃える
    this.yaw += mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    this.pitch = Math.max(
      -1.4,
      Math.min(1.4, this.pitch + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt),
    );
    this.dist = Math.max(C.MAP_MIN_DIST, Math.min(C.MAP_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0012)));
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      // Convert pixels to map-world metres at the current target plane.
      // The camera basis makes the gesture independent of orbit yaw/pitch.
      this.camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
      const metersPerPixel =
        (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))) /
        Math.max(1, window.innerHeight);
      this.pan.addScaledVector(right, -mouse.panDx * metersPerPixel);
      this.pan.addScaledVector(up, mouse.panDy * metersPerPixel);
    }
    const cp = Math.cos(this.pitch);
    // 太陽回転系表示: 太陽の実際の方位ドリフトぶんカメラ方位を追従させ、
    // 画面上で太陽方向がほぼ固定されて見えるようにする(予測サンプルの回転補正と
    // 組み合わせて、t=simTime では回転量ゼロで整合する)。
    const displayYaw = this.yaw + (this.frameRotating ? sunAz : 0);
    const targetX = focusRel.x + this.pan.x;
    const targetY = focusRel.y + this.pan.y;
    const targetZ = focusRel.z + this.pan.z;
    this.camera.position.set(
      targetX + cp * Math.cos(displayYaw) * this.dist,
      targetY + Math.sin(this.pitch) * this.dist,
      targetZ + cp * Math.sin(displayYaw) * this.dist,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(targetX, targetY, targetZ);
    const aspect = window.innerWidth / window.innerHeight;
    if (Math.abs(this.camera.aspect - aspect) > 1e-6) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}
