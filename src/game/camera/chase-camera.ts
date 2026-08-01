// 自機を画面中心に置く三人称軌道カメラ。update() は毎フレーム両方の基準フレームを
// 算出し、camFollowAttitude で切り替える: 既定値の true では機体姿勢基準
// (上 = 機体 +Y、前 = 機体 +Z)を使うため、I/K/J/L/U/O での回転がそのままカメラへ
// 反映される。false にすると軌道基準(上 = 動径方向(地球と反対)、前 = 速度方向)に
// なり、軌道運動とともにゆっくり共回転するため地球が常に足元に見える。
import * as THREE from 'three/webgpu';
import { add, addScaled, cross, dot, norm, scale, v3, Vec3 } from '../../physics/vec3';
import { MouseDelta } from '../input/input';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { qRotate } from '../../physics/attitude';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';
import { ndcToScreen, projectToNdc, ViewFrame } from '../../physics/projection';
import { ProjectFn } from './camera-system';

export class ChaseCamera {
  // 戦闘ビュー用のカメラ。アスペクト比は update() 毎に自己補正する。
  readonly camera = new THREE.PerspectiveCamera(
    C.BASE_FOV,
    window.innerWidth / window.innerHeight,
    C.COMBAT_CAMERA_NEAR,
    C.COMBAT_CAMERA_FAR,
  );
  private yaw = 0;
  private pitch = 0.3 - (10 * Math.PI) / 180;
  private dist = 38;
  private panEci: Vec3 = v3(0, 0, 0);
  camFollowAttitude = true;
  private fov = C.BASE_FOV;

  position: Vec3 = v3();      // 絶対 ECI のカメラ位置
  private upDir: Vec3 = v3(0, 1, 0);  // カメラ上方向(向き)
  private lookTarget: Vec3 = v3();    // 絶対 ECI の注視点
  private aspect = window.innerWidth / window.innerHeight;

  constructor(private readonly _hud: Hud, _sfx: Sfx) {}

  // 視点を初期状態にリセットする
  reset(): void {
    this.yaw = 0;
    this.pitch = 0.3 - (10 * Math.PI) / 180;
    this.dist = 38;
    this.panEci = v3(0, 0, 0);
  }

  // 視点の基準フレーム(機体姿勢基準 ⇔ 軌道基準)を切り替える。
  // panEci もリセットする: フレーム切替時に累積座標の意味が変わり視点がジャンプするのを防ぐ。
  toggleFollowAttitude(): void {
    this.camFollowAttitude = !this.camFollowAttitude;
    this.panEci = v3(0, 0, 0); // フレーム切替時に座標系不辺によるパンジャンプを防ぐ
    this._hud.hint(
      `視点のRCS追従: ${this.camFollowAttitude ? 'ON (視点が機体姿勢に追従)' : 'OFF (軌道基準の独立視点)'
      }`,
    );
  }

  // 現在のモード(通常/ズーム/機体死亡)に応じた視点を計算する。
  update(mouse: MouseDelta, keyYaw: number, keyPitch: number, dt: number, player: Player, zoomActive: boolean): void {
    this.yaw -= keyYaw * C.CAM_KEY_YAW_RATE * dt;
    this.pitch = Math.max(-1.35, Math.min(1.35,
      this.pitch + keyPitch * C.CAM_KEY_PITCH_RATE * dt
    ));

    // 速度方向を前方とする軌道基準フレームの up/fwd
    const chaseFwd = norm(player.state.v);
    const chaseUp = norm(player.state.r);
    // 姿勢基準フレームの前方向/上方向
    const boreFwd = qRotate(player.att.q, v3(0, 0, 1));
    const boreUp = qRotate(player.att.q, v3(0, 1, 0));

    const center = player.state.r;

    if (!player.alive) {
      this.computeChaseView(mouse, chaseUp, chaseFwd, dt, center);
    }
    else if (zoomActive) {
      this.computeGunsightView(boreFwd, boreUp, dt, center);
    }
    else if (this.camFollowAttitude) {
      this.computeChaseView(mouse, boreUp, boreFwd, dt, center);
    }
    else {
      this.computeChaseView(mouse, chaseUp, chaseFwd, dt, center);
    }
  }

  // 論理カメラの状態を THREE.PerspectiveCamera へ反映する。
  sync(fo: FloatingOrigin): void {
    const camera = this.camera;
    camera.position.copy(fo.RtoThreeV3(this.position));
    camera.up.set(this.upDir.x, this.upDir.y, this.upDir.z);
    camera.lookAt(fo.RtoThreeV3(this.lookTarget));
    // アスペクト比・FOV が変わったときだけ投影行列を再計算する
    let projectionDirty = false;
    if (Math.abs(camera.aspect - this.aspect) > 1e-6) {
      camera.aspect = this.aspect;
      projectionDirty = true;
    }
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      projectionDirty = true;
    }
    if (projectionDirty) camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  // THREE.js カメラ行列やフローティングオリジンに依存しないスクリーン投影関数。
  get projection(): ProjectFn {
    const view: ViewFrame = {
      position: this.position,
      lookTarget: this.lookTarget,
      up: this.upDir,
      fovDeg: this.fov,
      aspect: this.aspect,
    };
    return (worldPos) => ndcToScreen(projectToNdc(view, worldPos), window.innerWidth, window.innerHeight);
  }

  // 通常の三人称視点(マウスで yaw/pitch/dist を操作)。up/fwd の基準フレームは引数で受け取る。
  private computeChaseView(mouse: MouseDelta, up: Vec3, fwd: Vec3, dt: number, center: Vec3): void {
    this.computeZoomFov(false, dt);

    // マウス入力から yaw/pitch/距離を更新
    this.yaw -= mouse.dx * 0.005;
    this.pitch += mouse.dy * 0.005;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    this.dist *= Math.exp(mouse.wheel * 0.0012);
    this.dist = Math.max(12, Math.min(8000, this.dist));

    // fwd を up と直交する成分だけに正規化し、基準フレームを組む
    const f = norm(addScaled(fwd, up, -dot(fwd, up)));
    const side = norm(cross(f, up));

    // 球面座標(yaw/pitch/dist)からオフセットベクトルを組む
    const cp = Math.cos(this.pitch);
    let off = scale(f, -cp * Math.cos(this.yaw));
    off = addScaled(off, side, cp * Math.sin(this.yaw));
    off = addScaled(off, up, Math.sin(this.pitch));
    off = scale(off, this.dist);

    // 中ボタンドラッグ/2本指ドラッグでパン変位を更新する
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      const viewDir = scale(off, -1);
      const right = norm(cross(viewDir, up));
      const camUp = norm(cross(right, viewDir));
      const metersPerPixel =
        (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.fov * 0.5))) / Math.max(1, window.innerHeight);
      this.panEci = addScaled(this.panEci, right, -mouse.panDx * metersPerPixel);
      this.panEci = addScaled(this.panEci, camUp, mouse.panDy * metersPerPixel);
    }

    this.lookTarget = add(center, this.panEci);
    this.position = add(this.lookTarget, off);
    this.upDir = up;
  }

  // 照準ズーム中: 機体位置から機首方向を狙う固定ガンサイト視点(画面中心 = 照準先)。
  private computeGunsightView(boreFwd: Vec3, boreUp: Vec3, dt: number, center: Vec3): void {
    this.computeZoomFov(true, dt);

    this.position = center;
    this.upDir = norm(boreUp);
    this.lookTarget = addScaled(center, norm(boreFwd), 1000);
  }

  // アスペクト比を最新化し、FOV をズーム有無の目標値へ指数的に近づける。
  private computeZoomFov(zoomActive: boolean, dt: number): void {
    this.aspect = window.innerWidth / window.innerHeight;
    const targetFov = zoomActive ? C.ZOOM_FOV : C.BASE_FOV;
    const k = 1 - Math.exp(-C.ZOOM_LERP_RATE * dt);
    this.fov += (targetFov - this.fov) * k;
  }
}
