// カメラの向きをクォータニオン1本で保ち、画面ドラッグと極軸まわりのオイラー操作をそこへ積む。
// 姿勢追従中は生の値を対象姿勢からの相対値として持ち、実効回転で姿勢を合成する。
import {
  LOCAL_FORWARD, LOCAL_UP, type Quat, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate,
} from '../../math/quat';
import { POLAR_PITCH_LIMIT, eulerFromRotation, rotationFromEuler } from '../../math/polar-euler';
import { addScaled, cross, norm, scale, type Vec3 } from '../../math/vec3';

// 視点の回し方。オイラーは極軸を天頂とした方位・仰角で、クォータニオンは画面基準で回す。
export type CameraRotationMode = 'quaternion' | 'euler';

// 画面ドラッグと回転キーを、いまの向き rotation へ積む。すべて [rad] で受け、感度の換算は
// 呼び出し側が済ませておく。
function rotateByScreenDrag(
  rotation: Quat, dragRight: number, dragUp: number, roll: number, keyYaw: number, keyPitch: number,
): Quat {
  let q = rotation;
  // ヨー/ピッチは現在の上軸/右軸まわりに回す — ロールで上方向が傾いても画面上の動きと入力方向が揃う。
  if (keyYaw !== 0) q = qNormalize(qMul(qFromAxisAngle(qRotate(q, LOCAL_UP), -keyYaw), q));
  if (keyPitch !== 0) {
    const right = norm(cross(norm(qRotate(q, LOCAL_FORWARD)), qRotate(q, LOCAL_UP)));
    q = qNormalize(qMul(qFromAxisAngle(right, keyPitch), q));
  }
  // +Z は注視点からカメラへ向く軸。ドラッグの回転軸はドラッグ方向とこの視線軸の外積にする —
  // 逆向き(-forward)を使うと左右ドラッグの回転符号が反転する。
  const forward = qRotate(q, LOCAL_FORWARD);
  const up = qRotate(q, LOCAL_UP);
  const screenRight = norm(cross(scale(forward, -1), up));
  const dragVec = addScaled(scale(screenRight, dragRight), up, dragUp);
  const dragLen = Math.hypot(dragVec.x, dragVec.y, dragVec.z);
  if (dragLen > 1e-9) q = qNormalize(qMul(qFromAxisAngle(norm(cross(dragVec, forward)), dragLen), q));
  if (roll !== 0) q = qNormalize(qMul(qFromAxisAngle(qRotate(q, LOCAL_FORWARD), roll), q));
  return q;
}

export class CameraOrientation {
  // 合成に使う追従対象の姿勢。進行から引き直せるキャッシュで、まだ引けていなければ null。
  private attitude: Quat | null = null;

  // rotation は追従中なら対象姿勢からの相対値、そうでなければ絶対の向き。
  public constructor(
    private rotation: Quat,
    private mode: CameraRotationMode,
    private following: boolean,
  ) {}

  // 生の値。追従中は対象姿勢からの相対値。
  public get raw(): Quat { return this.rotation; }

  public get rotationMode(): CameraRotationMode { return this.mode; }

  public get followingAttitude(): boolean { return this.following; }

  // 入力をオイラー角として積むか。
  public get usesEuler(): boolean { return this.mode === 'euler'; }

  // 姿勢追従を掛けた、描画・入力に使う実効回転。
  public effective(): Quat {
    return this.following && this.attitude !== null ? qMul(this.attitude, this.rotation) : this.rotation;
  }

  // 実効回転から生の値へ書き戻す(追従中は相対値へ読み替える)。
  public setEffective(effective: Quat): void {
    this.rotation = this.following && this.attitude !== null
      ? qNormalize(qMul(qInvert(this.attitude), effective)) : qNormalize(effective);
  }

  // 生の値を差し替える。追従中に渡した向きは、対象姿勢からの相対値として扱われる。
  public setRaw(rotation: Quat): void {
    this.rotation = rotation;
  }

  // 極軸 polar を天頂とする方位・仰角・ロールへ増分を積む。仰角は真上・真下の手前で止める。
  public turn(dYaw: number, dPitch: number, dRoll: number, polar: Vec3): void {
    const euler = eulerFromRotation(this.rotation, polar);
    this.rotation = rotationFromEuler({
      yaw: euler.yaw + dYaw,
      pitch: Math.max(-POLAR_PITCH_LIMIT, Math.min(POLAR_PITCH_LIMIT, euler.pitch + dPitch)),
      roll: euler.roll + dRoll,
    }, polar);
  }

  // 画面ドラッグと回転キーで実効回転を回す。すべて [rad] で、感度の換算は呼び出し側が済ませておく。
  public turnByDrag(
    dragRight: number, dragUp: number, roll: number, keyYaw: number, keyPitch: number,
  ): void {
    this.setEffective(rotateByScreenDrag(this.effective(), dragRight, dragUp, roll, keyYaw, keyPitch));
  }

  // 回し方を切り替える。保持している向きはそのままで、次の入力からの積み方だけが変わる。
  public setRotationMode(mode: CameraRotationMode): void {
    this.mode = mode;
  }

  // 姿勢追従を始める。保持していた絶対の向きを、対象姿勢からの相対値へ読み替える。
  public beginAttitudeFollow(attitude: Quat): void {
    this.rotation = qNormalize(qMul(qInvert(attitude), this.rotation));
    this.attitude = attitude;
    this.following = true;
  }

  // 姿勢追従を解き、生の値を絶対の向きへ読み替える(掛かっていなければ何もしない)。
  public endAttitudeFollow(): void {
    if (!this.following) return;
    if (this.attitude !== null) this.rotation = qNormalize(qMul(this.attitude, this.rotation));
    this.following = false;
    this.attitude = null;
  }

  // 追従の選択だけを差し替える。向きは読み替えず、追従中に追従へ戻す場合だけ基準の姿勢を持ち越す。
  public resetFollow(following: boolean): void {
    this.attitude = following && this.following ? this.attitude : null;
    this.following = following;
  }

  // 合成に使う姿勢を最新へ更新する。解決できないフレームは直前の姿勢を維持する(視点の急変を防止)。
  public refreshAttitude(attitude: Quat | null): void {
    if (!this.following || attitude === null) return;
    this.attitude = attitude;
  }
}
