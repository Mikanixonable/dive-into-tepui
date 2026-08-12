// 自機を中心とした三人称軌道視点。姿勢は単位クオータニオン(rot)と距離(dist)だけで持つ。
// rot の意味は camFollowAttitude で切り替わる: true なら機体姿勢に対する相対姿勢、false なら
// ワールド(ECI)に対する絶対姿勢。切り替え時は player の姿勢クオータニオンを掛け/割って読み替える。
import { add, addScaled, cross, len, norm, scale, v3, Vec3 } from '../../physics/vec3';
import { MouseDelta } from '../input/input';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Quat, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate } from '../../physics/attitude';
import { Player } from '../player/player';
import { metersPerPixelAtDepth, Viewpoint } from '../../physics/projection';
import { ChaseCameraSaveData } from '../save-data';

// 初期視点: 機体後方やや上から見下ろす。
const DEFAULT_ROT: Quat = qFromAxisAngle(v3(1, 0, 0), 0.3 - (10 * Math.PI) / 180);
const DEFAULT_DIST = 38;

export class ChaseCamera {
  private rot: Quat = DEFAULT_ROT;
  dist = DEFAULT_DIST;
  private _camFollowAttitude = true;
  // 前フレームの player.alive。真偽が変わった瞬間だけ rot を読み替えるための検出用。
  private _prevAlive = true;
  private panEci: Vec3 = v3(0, 0, 0);

  viewpoint: Viewpoint = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.BASE_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  // saved があればその状態から組む。rot はセーブ時点の基準フレーム(機体姿勢基準/ワールド基準)
  // での値のまま代入する — camFollowAttitude セッターは基準の切替時に rot を読み替えるため、
  // 経由すると意味が変わってしまう。
  constructor(
    private readonly _hud: Hud,
    private player: Player | null,
    saved?: ChaseCameraSaveData,
  ) {
    if (saved) {
      this.rot = qNormalize({ x: saved.rot.x, y: saved.rot.y, z: saved.rot.z, w: saved.rot.w });
      this.dist = saved.dist;
      this.panEci = v3(saved.pan.x, saved.pan.y, saved.pan.z);
      this._camFollowAttitude = saved.followAttitude;
    }
  }

  // 追従先の艦を差し替える(アクティブ艦の切替)。姿勢基準の rot はそのまま新しい艦の姿勢に対する
  // 相対値として使い回す。
  setPlayer(player: Player | null): void {
    this.player = player;
    this._prevAlive = player?.alive ?? true;
  }

  // rot の相対/絶対の解釈を切り替える。toRelative が true なら「以後は機体姿勢に対する相対値」
  // として、false なら「以後は現在の向きをそのまま絶対値」として扱えるよう rot 自体を変換する。
  private reinterpretRot(toRelative: boolean): Quat {
    const playerQ = this.player!.att.q;
    return qNormalize(toRelative ? qMul(qInvert(playerQ), this.rot) : qMul(playerQ, this.rot));
  }

  // 視点の基準フレーム(機体姿勢基準 true ⇔ ワールド基準 false)。書き換え時に rot を読み替える。
  get camFollowAttitude(): boolean {
    return this._camFollowAttitude;
  }
  set camFollowAttitude(v: boolean) {
    if (v === this._camFollowAttitude) return;
    if (!this.player) return;
    this.rot = this.reinterpretRot(v);
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
    if (!this.player) return;
    // 機体姿勢基準のまま撃破された/復活した瞬間は、その時点の折り込み済みの向きを
    // 絶対値として固定する(逆方向も同様)。rot の意味そのものが変わるので読み替えが要る。
    if (this._camFollowAttitude && this.player.alive !== this._prevAlive) {
      this.rot = this.reinterpretRot(this.player.alive);
    }
    this._prevAlive = this.player.alive;

    const followNow = this._camFollowAttitude && this.player.alive;
    let q = followNow ? qMul(this.player.att.q, this.rot) : this.rot;

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
      const metersPerPixel = metersPerPixelAtDepth(C.BASE_FOV, this.dist, Math.max(1, window.innerHeight));
      this.panEci = addScaled(this.panEci, right, mouse.panDx * metersPerPixel);
      this.panEci = addScaled(this.panEci, up, mouse.panDy * metersPerPixel);
    }

    this.rot = followNow ? qNormalize(qMul(qInvert(this.player.att.q), q)) : q;

    const center = this.player.state.r;
    const lookTarget = add(center, this.panEci);
    this.viewpoint = {
      position: add(lookTarget, scale(qRotate(q, v3(0, 0, -1)), this.dist)),
      up: qRotate(q, v3(0, 1, 0)),
      lookTarget: lookTarget,
      fovDeg: C.BASE_FOV,
      aspect: window.innerWidth / window.innerHeight,
    };
  }

  // rot/dist/panEci/camFollowAttitude をセーブデータへ書き出す。
  serialize(): ChaseCameraSaveData {
    return {
      rot: { x: this.rot.x, y: this.rot.y, z: this.rot.z, w: this.rot.w },
      dist: this.dist,
      pan: { x: this.panEci.x, y: this.panEci.y, z: this.panEci.z },
      followAttitude: this._camFollowAttitude,
    };
  }
}
