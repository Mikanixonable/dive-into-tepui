// 自機を中心とした三人称軌道視点。姿勢は単位クオータニオン(rot)と距離(dist)だけで持つ。
// rot の意味は camFollowAttitude で切り替わる: true なら機体姿勢に対する相対姿勢、false なら
// ワールド(ECI)に対する絶対姿勢。切り替え時は player の姿勢クオータニオンを掛け/割って読み替える。
import { add, addScaled, cross, len, norm, scale, v3, Vec3 } from '../../physics/vec3';
import { MouseDelta } from '../input/input';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Quat, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate } from '../../physics/attitude';
import { Player } from '../player/player';
import { ViewFrame } from '../../physics/projection';

// 初期視点: 機体後方やや上から見下ろす。
const DEFAULT_ROT: Quat = qFromAxisAngle(v3(1, 0, 0), 0.3 - (10 * Math.PI) / 180);
const DEFAULT_DIST = 38;

export class ChaseCamera {
  private rot: Quat = DEFAULT_ROT;
  dist = DEFAULT_DIST;
  private _camFollowAttitude = true;
  private panEci: Vec3 = v3(0, 0, 0);

  view: ViewFrame = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.BASE_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  constructor(
    private readonly _hud: Hud,
    private readonly player: Player,
  ) { }

  // 視点の基準フレーム(機体姿勢基準 true ⇔ ワールド基準 false)。書き換え時に rot を読み替える。
  get camFollowAttitude(): boolean {
    return this._camFollowAttitude;
  }
  set camFollowAttitude(v: boolean) {
    if (v === this._camFollowAttitude) return;
    const playerQ = this.player.att.q;
    this.rot = qNormalize(v ? qMul(qInvert(playerQ), this.rot) : qMul(playerQ, this.rot));
    this._camFollowAttitude = v;
  }

  // 視点を初期状態にリセットする
  reset(): void {
    this.rot = DEFAULT_ROT;
    this.dist = DEFAULT_DIST;
    this.panEci = v3(0, 0, 0);
  }

  // 視点の基準フレームを切り替える。
  toggleFollowAttitude(): void {
    this.camFollowAttitude = !this.camFollowAttitude;
    this.panEci = v3(0, 0, 0); // フレーム切替時に座標系不辺によるパンジャンプを防ぐ
    this._hud.hint(
      `視点のRCS追従: ${this.camFollowAttitude ? 'ON (視点が機体姿勢に追従)' : 'OFF (ワールド基準の独立視点)'
      }`,
    );
  }

  // キー/マウス入力から rot/dist を更新し、player の状態から視点を view へ書き戻す。
  update(mouse: MouseDelta, keyYaw: number, keyPitch: number, keyRoll: number, dt: number): void {
    let q = this._camFollowAttitude ? qMul(this.player.att.q, this.rot) : this.rot;

    const right = qRotate(q, v3(1, 0, 0));
    const up = qRotate(q, v3(0, 1, 0));
    const view = qRotate(q, v3(0, 0, 1));

    if (keyYaw !== 0) q = qMul(qFromAxisAngle(up, -keyYaw * C.CAM_KEY_YAW_RATE * dt), q);
    if (keyPitch !== 0) q = qMul(qFromAxisAngle(right, keyPitch * C.CAM_KEY_PITCH_RATE * dt), q);
    if (keyRoll !== 0) q = qMul(qFromAxisAngle(view, keyRoll * C.CAM_KEY_ROLL_RATE * dt), q);

    // ドラッグベクトルと視線ベクトルの外積を回転軸とする: 軸は視線と直交するので視線まわりの
    // ロールが生じず、「カメラから見て」ドラッグ方向とカメラの回転方向が一致する。
    const dragVec = addScaled(scale(right, mouse.dx), up, mouse.dy);
    const dragLen = len(dragVec);
    if (dragLen > 1e-9) {
      const axis = norm(cross(dragVec, view));
      q = qMul(qFromAxisAngle(axis, dragLen * C.CAM_DRAG_ROTATE_RATE), q);
    }
    q = qNormalize(q);

    this.dist *= Math.exp(mouse.wheel * 0.0012);
    this.dist = Math.max(12, Math.min(8000, this.dist));

    // 中ボタンドラッグ等によるパン変位
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      const fovRad = (C.BASE_FOV * Math.PI) / 180;
      const metersPerPixel = (2 * this.dist * Math.tan(fovRad * 0.5)) / Math.max(1, window.innerHeight);
      this.panEci = addScaled(this.panEci, right, mouse.panDx * metersPerPixel);
      this.panEci = addScaled(this.panEci, up, mouse.panDy * metersPerPixel);
    }

    this.rot = this._camFollowAttitude ? qNormalize(qMul(qInvert(this.player.att.q), q)) : q;

    const center = this.player.state.r;
    const lookTarget = add(center, this.panEci);
    this.view = {
      position: add(lookTarget, scale(qRotate(q, v3(0, 0, -1)), this.dist)),
      up: qRotate(q, v3(0, 1, 0)),
      lookTarget: lookTarget,
      fovDeg: C.BASE_FOV,
      aspect: window.innerWidth / window.innerHeight,
    };
  }
}
