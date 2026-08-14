// 自機を画面中心に置く戦闘視点。ChaseCamera(三人称軌道視点)と GunsightCamera(照準ズーム視点)を
// zoomActive で切り替えて駆動し、両者が viewpoint に持つ定常 FOV へ自身の viewpoint.fovDeg を
// 指数関数的に近づけるアニメーションを担う(FOV アニメーション自体は両カメラの責務にしない —
// 今後増える視点種別も viewpoint.fovDeg を持つだけで済むようにするため)。camFollowAttitude
// (視点の基準フレーム切り替え)の状態と読み替え処理は ChaseCamera が持つが、[G]キーの受け口は
// このクラスの update() が持つ — 追従対象は毎フレームの引数でしか渡らないため。
import * as THREE from 'three/webgpu';
import { v3 } from '../../physics/vec3';
import { Input, MouseDelta } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Player } from '../player/player';
import { Viewpoint } from '../../physics/projection';
import { ChaseCamera } from './chase-camera';
import { GunsightCamera } from './gunsight-camera';
import { ChaseCameraSaveData } from '../save-data';

// current から target へ、fovDeg だけを指数的に近づけた Viewpoint を返す(position/lookTarget/up/
// aspect はアニメーションせず target の値をそのまま採用する — カメラの向き自体は毎フレーム
// 追従してよく、揺れて見えるのは FOV だけで十分なため)。
function lerpViewpointFov(current: Viewpoint, target: Viewpoint, dt: number): Viewpoint {
  const k = 1 - Math.exp(-C.ZOOM_LERP_RATE * dt);
  return { ...target, fovDeg: current.fovDeg + (target.fovDeg - current.fovDeg) * k };
}

export class CombatCameraSystem {
  // 戦闘ビュー用のカメラ。アスペクト比は update() 毎に自己補正する。
  readonly camera = new THREE.PerspectiveCamera(
    C.BASE_FOV,
    window.innerWidth / window.innerHeight,
    C.COMBAT_CAMERA_NEAR,
    C.COMBAT_CAMERA_FAR,
  );
  readonly chaseCamera: ChaseCamera;
  readonly gunsightCamera = new GunsightCamera();
  zoomActive = false;

  viewpoint: Viewpoint = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.BASE_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  constructor(_hud: Hud, saved?: ChaseCameraSaveData) {
    this.chaseCamera = new ChaseCamera(_hud, saved);
  }

  // 視点を初期状態にリセットする。
  reset(): void {
    this.chaseCamera.reset();
  }

  get camFollowAttitude(): boolean {
    return this.chaseCamera.camFollowAttitude;
  }

  // CameraSystem.sync が読む近クリップ距離。OverviewCamera の同名 getter と読み口を揃える。
  get near(): number {
    return C.COMBAT_CAMERA_NEAR;
  }

  // CameraSystem.sync が読む遠クリップ距離。OverviewCamera の同名 getter と読み口を揃える。
  get far(): number {
    return C.COMBAT_CAMERA_FAR;
  }

  // ズーム状態を入力から求め、現在のモード(通常/ズーム)に応じて ChaseCamera/GunsightCamera の
  // どちらかを駆動して目標 Viewpoint を求め、fovDeg だけをそこへ指数的に近づけて viewpoint とする。
  update(mouse: MouseDelta, keyYaw: number, keyPitch: number, keyRoll: number, dt: number, player: Player | null, input: Input): void {
    if (input.takeKey(K.followAttitudeToggle)) this.chaseCamera.toggleFollowAttitude(player);
    this.zoomActive = input.down(K.gunsightZoom);
    // 操作対象艦がいなければ照準先が無いので、ズーム要求は無視して追跡視点のままにする。
    const useGunsight = player !== null && this.zoomActive;
    if (useGunsight) this.gunsightCamera.update(player);
    else this.chaseCamera.update(mouse, keyYaw, keyPitch, keyRoll, dt, player);
    const target = useGunsight ? this.gunsightCamera.viewpoint : this.chaseCamera.viewpoint;
    this.viewpoint = lerpViewpointFov(this.viewpoint, target, dt);
  }

  serialize(): ChaseCameraSaveData {
    return this.chaseCamera.serialize();
  }
}
