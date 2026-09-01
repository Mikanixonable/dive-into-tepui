// 自機を画面中心に置く戦闘視点。ChaseCamera(三人称軌道視点)と GunsightCamera(照準ズーム視点)を
// zoomActive で切り替えて駆動し、両者が viewpoint に持つ定常 FOV へ自身の viewpoint.fovDeg を
// 指数関数的に近づけるアニメーションを担う(FOV アニメーション自体は両カメラの責務にしない —
// 今後増える視点種別も viewpoint.fovDeg を持つだけで済むようにするため)。camFollowAttitude
// (視点の基準フレーム切り替え)の状態と読み替え処理は ChaseCamera が持つが、[G]キーの受け口は
// このクラスの update() が持つ — 追従対象は毎フレームの引数でしか渡らないため。
import * as THREE from 'three/webgpu';
import { v3 } from '../../math/vec3';
import { Input, MouseDelta } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { Player } from '../player/player';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { Viewpoint } from '../../math/projection';
import { ChaseCamera, BASE_FOV } from './chase-camera';
import { GunsightCamera } from './gunsight-camera';
import { ChaseCameraSaveData } from '../save/save-data';

// 戦闘視点カメラの near/far [m]。反転 32bit 深度では復元誤差が距離に比例し near に依らないので、
// near は精度のためではなく「カメラが物へめり込む手前で切り取られない」値として置く。far は球
// として描かれる天体のうち見かけ直径が 2px を超える最遠のもの — 直径 1.4e9 m の恒星を LOD 上限で
// 見た 1.4e12 m — が入る距離。far を広げる費用は事実上ゼロ。
const COMBAT_CAMERA_NEAR = 2;
const COMBAT_CAMERA_FAR = 2e12;

const ZOOM_LERP_RATE = 9; // 画角遷移の追従速度 [1/s]

// current から target へ、fovDeg だけを指数的に近づけた Viewpoint を返す(position/lookTarget/up/
// aspect はアニメーションせず target の値をそのまま採用する — カメラの向き自体は毎フレーム
// 追従してよく、揺れて見えるのは FOV だけで十分なため)。
function lerpViewpointFov(current: Viewpoint, target: Viewpoint, dt: number): Viewpoint {
  const k = 1 - Math.exp(-ZOOM_LERP_RATE * dt);
  return { ...target, fovDeg: current.fovDeg + (target.fovDeg - current.fovDeg) * k };
}

export class CombatCameraSystem {
  // 戦闘ビュー用のカメラ。アスペクト比は update() 毎に自己補正する。
  readonly camera = new THREE.PerspectiveCamera(
    BASE_FOV,
    window.innerWidth / window.innerHeight,
    COMBAT_CAMERA_NEAR,
    COMBAT_CAMERA_FAR,
  );
  readonly chaseCamera: ChaseCamera;
  readonly gunsightCamera = new GunsightCamera();
  zoomActive = false;

  viewpoint: Viewpoint = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: BASE_FOV,
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

  // CameraSystem.sync が読む近クリップ距離。MapCamera の同名 getter と読み口を揃える。
  get near(): number {
    return COMBAT_CAMERA_NEAR;
  }

  // CameraSystem.sync が読む遠クリップ距離。MapCamera の同名 getter と読み口を揃える。
  get far(): number {
    return COMBAT_CAMERA_FAR;
  }

  // ズーム状態を入力から求め、現在のモード(通常/ズーム)に応じて ChaseCamera/GunsightCamera の
  // どちらかを駆動して目標 Viewpoint を求め、fovDeg だけをそこへ指数的に近づけて viewpoint とする。
  update(mouse: MouseDelta, keyYawRad: number, keyPitchRad: number, dt: number, player: DynamicEntity | null, input: Input): void {
    if (input.takeKey(K.followAttitudeToggle)) this.chaseCamera.toggleFollowAttitude(player);
    this.zoomActive = input.down(K.gunsightZoom);
    // 操作対象艦がいなければ照準先が無いので、ズーム要求は無視して追跡視点のままにする。
    const useGunsight = player instanceof Player && this.zoomActive;
    if (useGunsight) this.gunsightCamera.update(player);
    else this.chaseCamera.update(mouse, keyYawRad, keyPitchRad, player);
    const target = useGunsight ? this.gunsightCamera.viewpoint : this.chaseCamera.viewpoint;
    this.viewpoint = lerpViewpointFov(this.viewpoint, target, dt);
  }

  serialize(): ChaseCameraSaveData {
    return this.chaseCamera.serialize();
  }
}
