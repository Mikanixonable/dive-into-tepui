// 自機を画面中心に置く三人称軌道カメラ。
// 基準フレームは「上 = 動径方向(地球と反対)、前 = 速度方向」で、
// 軌道運動とともにゆっくり共回転するため地球が常に足元に見える。
import * as THREE from 'three/webgpu';
import { add, addScaled, clone, cross, dot, norm, scale, v3, Vec3 } from '../../physics/vec3';
import { MouseDelta } from '../input/input';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { qRotate } from '../../physics/attitude';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';

export class ChaseCamera {
  // 戦闘ビュー用のカメラ。near=2m なら地平線距離(~2,400km)での深度誤差も大気シェルの
  // 厚みより十分小さく、対数深度バッファなしで z-fighting を回避できる(far=6e7m は
  // 星空シェルを含む)。window resize には追従せず、update() 呼び出し毎にアスペクト比を
  // 自己補正する(このカメラは Game 構築時に生成されるため、resize イベントリスナーを
  // 先に張れない — map-camera.ts の MapCamera と同じ方式)。
  readonly camera = new THREE.PerspectiveCamera(
    C.BASE_FOV,
    window.innerWidth / window.innerHeight,
    2,
    6e7,
  );
  yaw = 0; // 0 = 機体後方(プログレード側から見る)
  pitch = 0.3 - (10 * Math.PI) / 180; // 初期カメラ位置を5度低く
  dist = 38;
  camFollowAttitude = true;
  private fov = C.BASE_FOV;

  // update() が算出し sync() が camera へ反映する視点の数学状態。ビュー計算・保持は
  // すべて慣性系(physics/vec3、絶対 ECI)で行い、THREE.js への変換は sync() が fo 経由で
  // 行うだけ。update は物理積分の後に呼ばれるため、ここで参照する自機位置は fo.r と同一
  // (=積分後)であり、絶対値保管でフレームずれは生じない。
  position: Vec3 = v3();      // 絶対 ECI のカメラ位置
  private upDir: Vec3 = v3(0, 1, 0);  // カメラ上方向(向き)
  private lookTarget: Vec3 = v3();    // 絶対 ECI の注視点
  private aspect = window.innerWidth / window.innerHeight;

  // sfx は現状未使用だが、hud/sfx は必ず対で注入する方針のため受け取る(フィールドとしては保持しない)。
  constructor(private readonly _hud: Hud, _sfx: Sfx) {}

  toggleFollowAttitude(): void {
    this.camFollowAttitude = !this.camFollowAttitude;
    this._hud.hint(
      `視点のRCS追従: ${this.camFollowAttitude ? 'ON (視点が機体姿勢に追従)' : 'OFF (軌道基準の独立視点)'
      }`,
    );
  }

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

    // 追従中心 = 自機の絶対 ECI 位置(update は積分後に呼ばれるので fo.r と一致する)。
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

  // update() で算出した絶対 ECI の視点状態を fo 経由で描画フレームへ変換して camera に
  // 反映する(位置・注視点は toThreeVector3、上方向は向きなので変換せずそのまま)。
  sync(fo: FloatingOrigin): void {
    const camera = this.camera;
    camera.position.copy(fo.RtoThreeV3(this.position));
    camera.up.set(this.upDir.x, this.upDir.y, this.upDir.z);
    camera.lookAt(fo.RtoThreeV3(this.lookTarget));
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

  // 通常の三人称視点(マウスでyaw/pitch/distを操作、up/fwdの基準フレームは
  // 呼び出し側が決める — 機体姿勢基準か軌道基準かはCameraSystemの責務)。
  private computeChaseView(mouse: MouseDelta, up: Vec3, fwd: Vec3, dt: number, center: Vec3): void {
    this.computeZoomFov(false, dt);

    this.yaw -= mouse.dx * 0.005;
    this.pitch += mouse.dy * 0.005;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    this.dist *= Math.exp(mouse.wheel * 0.0012);
    this.dist = Math.max(12, Math.min(8000, this.dist));

    // 前方向を上方向と直交化した正規直交フレーム
    const f = norm(addScaled(fwd, up, -dot(fwd, up)));
    const side = norm(cross(f, up));

    const cp = Math.cos(this.pitch);
    let off = scale(f, -cp * Math.cos(this.yaw));
    off = addScaled(off, side, cp * Math.sin(this.yaw));
    off = addScaled(off, up, Math.sin(this.pitch));
    off = scale(off, this.dist);

    this.position = add(center, off);
    this.upDir = up;
    this.lookTarget = clone(center);
  }

  // 照準ズーム中: 三人称視点をやめ、機体位置(原点)から機首方向を狙う
  // 固定ガンサイト視点にする(画面中心 = 照準先、自機は呼び出し側で非表示にする)。
  // 姿勢操作(I/K/J/L)で狙いを付ける設計のため、マウスでの視点回転は行わない。
  private computeGunsightView(boreFwd: Vec3, boreUp: Vec3, dt: number, center: Vec3): void {
    this.computeZoomFov(true, dt);

    this.position = clone(center);
    this.upDir = norm(boreUp);
    this.lookTarget = addScaled(center, norm(boreFwd), 1000);
  }

  private computeZoomFov(zoomActive: boolean, dt: number): void {
    this.aspect = window.innerWidth / window.innerHeight;
    const targetFov = zoomActive ? C.ZOOM_FOV : C.BASE_FOV;
    const k = 1 - Math.exp(-C.ZOOM_LERP_RATE * dt);
    this.fov += (targetFov - this.fov) * k;
  }
}
