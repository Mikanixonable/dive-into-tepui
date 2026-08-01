// 自機を中心とした三人称軌道カメラ。yaw/pitch/dist の球面座標に加え、基準フレームの
// 切り替え(camFollowAttitude: 機体姿勢基準 ⇔ 軌道基準)も自身の状態として持つ。
import { add, addScaled, cross, dot, norm, scale, v3 } from '../../physics/vec3';
import { MouseDelta } from '../input/input';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { qRotate } from '../../physics/attitude';
import { Player } from '../player/player';
import { ViewFrame } from '../../physics/projection';

export class ChaseCamera {
  yaw = 0; // 0 = 基準フレームの後方(プログレード側)から見る
  pitch = 0.3 - (10 * Math.PI) / 180; // 初期カメラ位置を5度低く
  dist = 38;
  // 既定値 true: 機体姿勢基準(上 = 機体 +Y、前 = 機体 +Z)を使うため、I/K/J/L/U/O での
  // 回転がそのままカメラへ反映される。false では軌道基準(上 = 動径方向(地球と反対)、
  // 前 = 速度方向)になり、軌道運動とともにゆっくり共回転するため地球が常に足元に見える。
  // 機体が死亡している間は姿勢自体が意味を持たないため、値によらず軌道基準を使う。
  camFollowAttitude = true;
  view: ViewFrame = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.BASE_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  constructor(private readonly _hud: Hud) {}

  // 視点を初期状態にリセットする
  reset(): void {
    this.yaw = 0;
    this.pitch = 0.3 - (10 * Math.PI) / 180;
    this.dist = 38;
  }

  // 視点の基準フレーム(機体姿勢基準 ⇔ 軌道基準)を切り替える。
  toggleFollowAttitude(): void {
    this.camFollowAttitude = !this.camFollowAttitude;
    this._hud.hint(
      `視点のRCS追従: ${this.camFollowAttitude ? 'ON (視点が機体姿勢に追従)' : 'OFF (軌道基準の独立視点)'
      }`,
    );
  }

  // キー/マウス入力から yaw/pitch/dist を更新し、player の状態から基準フレームを選んで視点を view へ書き戻す。
  update(mouse: MouseDelta, keyYaw: number, keyPitch: number, dt: number, player: Player): void {
    this.yaw -= keyYaw * C.CAM_KEY_YAW_RATE * dt;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + keyPitch * C.CAM_KEY_PITCH_RATE * dt));

    this.yaw -= mouse.dx * 0.005;
    this.pitch += mouse.dy * 0.005;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
    this.dist *= Math.exp(mouse.wheel * 0.0012);
    this.dist = Math.max(12, Math.min(8000, this.dist));

    // 速度方向を前方とする軌道基準フレームの up/fwd
    let up = norm(player.state.r);
    let fwd = norm(player.state.v);
    if (this.camFollowAttitude && player.alive) {
      // 姿勢基準フレームの前方向/上方向
      fwd = qRotate(player.att.q, v3(0, 0, 1));
      up = qRotate(player.att.q, v3(0, 1, 0));
    }
    const center = player.state.r;

    // fwd を up と直交する成分だけに正規化し、基準フレームを組む
    const f = norm(addScaled(fwd, up, -dot(fwd, up)));
    const side = norm(cross(f, up));

    // 球面座標(yaw/pitch/dist)からオフセットベクトルを組む
    const cp = Math.cos(this.pitch);
    let off = scale(f, -cp * Math.cos(this.yaw));
    off = addScaled(off, side, cp * Math.sin(this.yaw));
    off = addScaled(off, up, Math.sin(this.pitch));
    off = scale(off, this.dist);

    this.view = {
      position: add(center, off),
      up,
      lookTarget: center,
      fovDeg: C.BASE_FOV,
      aspect: window.innerWidth / window.innerHeight,
    };
  }
}

