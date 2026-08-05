// 自機を画面中心に置く戦闘視点。ChaseCamera(三人称軌道視点)と GunsightCamera(照準ズーム視点)を
// zoomActive で切り替えて駆動し、両者が view に持つ定常 FOV へ自身の view.fovDeg を指数関数的に
// 近づけるアニメーションを担う(FOV アニメーション自体は両カメラの責務にしない — 今後増える
// 視点種別も view.fovDeg を持つだけで済むようにするため)。camFollowAttitude(視点の基準フレーム
// 切り替え)とその判断は ChaseCamera が持つ — CombatCameraSystem は [G]キーの受け口として
// toggleFollowAttitude() を転送するだけ。
import * as THREE from 'three/webgpu';
import { v3 } from '../../physics/vec3';
import { Input, MouseDelta } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Player } from '../player/player';
import { ViewFrame } from '../../physics/projection';
import { ChaseCamera } from './chase-camera';
import { GunsightCamera } from './gunsight-camera';

// current から target へ、fovDeg だけを指数的に近づけた ViewFrame を返す(position/lookTarget/up/
// aspect はアニメーションせず target の値をそのまま採用する — カメラの向き自体は毎フレーム
// 追従してよく、揺れて見えるのは FOV だけで十分なため)。
function lerpViewFrameFov(current: ViewFrame, target: ViewFrame, dt: number): ViewFrame {
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

  view: ViewFrame = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.BASE_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  constructor(_hud: Hud, _sfx: Sfx, player: Player | null) {
    this.chaseCamera = new ChaseCamera(_hud, player);
  }

  // アクティブ艦の切替を追従カメラへ伝える。
  setActivePlayer(player: Player | null): void {
    this.chaseCamera.setPlayer(player);
  }

  // 視点を初期状態にリセットする(内部状態を持つのは ChaseCamera だけ)。
  reset(): void {
    this.chaseCamera.reset();
  }

  // 視点の基準フレーム(機体姿勢基準 ⇔ ワールド基準)を切り替える。判断は ChaseCamera に委譲する。
  toggleFollowAttitude(): void {
    this.chaseCamera.toggleFollowAttitude();
  }

  get camFollowAttitude(): boolean {
    return this.chaseCamera.camFollowAttitude;
  }

  // ズーム状態を入力から求め、現在のモード(通常/ズーム)に応じて ChaseCamera/GunsightCamera の
  // どちらかを駆動して目標 ViewFrame を求め、fovDeg だけをそこへ指数的に近づけて view とする。
  update(mouse: MouseDelta, keyYaw: number, keyPitch: number, keyRoll: number, dt: number, player: Player | null, input: Input): void {
    this.zoomActive = input.down(K.gunsightZoom);
    // 機体死亡中はズーム要求を無視して常に追跡視点へ戻す(照準先が失われているため)。
    const useGunsight = player?.alive === true && this.zoomActive;
    if (useGunsight) this.gunsightCamera.update(player);
    else this.chaseCamera.update(mouse, keyYaw, keyPitch, keyRoll, dt);
    const target = useGunsight ? this.gunsightCamera.view : this.chaseCamera.view;
    this.view = lerpViewFrameFov(this.view, target, dt);
  }
}
