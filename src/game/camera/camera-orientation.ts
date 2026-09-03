// カメラの向きを、クォータニオンと極軸まわりのオイラー角の二表現で保つ。どちらから書き換えても
// 両方が同じ向きを指すこと、姿勢追従中の生の値が対象姿勢からの相対値であることは、この中だけで
// 担保する。**極軸の選び方は持たない** — 天体から選ぶのはカメラの仕事なので、書き換えのたびに
// 受け取る。
import {
  LOCAL_FORWARD, LOCAL_UP, Quat, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate,
} from '../../math/quat';
import { PolarEuler, eulerAfterDrag, eulerFromRotation, rotationFromEuler } from '../../math/polar-euler';
import { addScaled, cross, norm, scale, type Vec3 } from '../../math/vec3';

// 視点の回し方。オイラーは極軸を天頂とした方位・仰角で、クォータニオンは画面基準で回す。
export type CameraRotationMode = 'quaternion' | 'euler';

// 画面ドラッグと回転キーを、いまの向き rotation へ積む。すべて [rad] で受け、感度の換算は
// 呼び出し側が済ませておく。ヨー/ピッチは固定のワールド軸ではなく現在の上軸/右軸まわりに
// 回すので、ロールで上方向が傾いても画面上の動きと入力方向が一致し続ける。
function rotateByScreenDrag(
  rotation: Quat, dragRight: number, dragUp: number, roll: number, keyYaw: number, keyPitch: number,
): Quat {
  let q = rotation;
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
  private euler: PolarEuler;

  // rotation は追従中なら対象姿勢からの相対値。attitude が null の間は絶対値のまま扱い、
  // 初めて姿勢が引けたときに相対値へ読み替える(ロード直後がこの状態)。
  public constructor(
    private rotation: Quat,
    polar: Vec3,
    private mode: CameraRotationMode,
    private following: boolean,
    private attitude: Quat | null,
  ) {
    this.euler = eulerFromRotation(rotation, polar);
  }

  // 保存と座標系変換が読む生の値。
  public get stored(): Quat { return this.rotation; }

  public get rotationMode(): CameraRotationMode { return this.mode; }

  public get followingAttitude(): boolean { return this.following; }

  // 入力をオイラー角として積むか。姿勢追従中は極軸が座標系の幾何で定まらないので積まない。
  public get usesEuler(): boolean { return this.mode === 'euler' && !this.following; }

  // 姿勢追従を掛けた、描画・入力に使う実効回転。
  public effective(): Quat {
    return this.following && this.attitude !== null ? qMul(this.attitude, this.rotation) : this.rotation;
  }

  // 実効回転から生の値へ書き戻す(追従中は相対値へ読み替える)。オイラー角は揃えない —
  // 極軸はカメラが動いた後の位置で決まるので、揃えるのは rebase() の役目。
  public store(effective: Quat): void {
    this.rotation = this.following && this.attitude !== null
      ? qNormalize(qMul(qInvert(this.attitude), effective)) : qNormalize(effective);
  }

  // 生の値を差し替える。
  public set(rotation: Quat, polar: Vec3): void {
    this.rotation = rotation;
    this.euler = eulerFromRotation(rotation, polar);
  }

  // 極軸が変わったぶん、オイラー角を引き直す。
  public rebase(polar: Vec3): void {
    this.euler = eulerFromRotation(this.rotation, polar);
  }

  // オイラー角から生の値を組み直す。極軸の変化を向きへ反映させる。
  public restoreFromEuler(polar: Vec3): void {
    this.rotation = rotationFromEuler(this.euler, polar);
  }

  // 画面ドラッグと回転キーの変位をオイラー角へ積み、組み直した実効回転を返す。dragX/dragY は
  // 画面右・画面下を正とする画面上の変位 [rad] で、ドラッグした向きへカメラが動くよう分解する。
  // 仰角は真上・真下の手前で止める。姿勢追従中は極軸が定まらないので、この経路は通らない(usesEuler)。
  public turn(dragX: number, dragY: number, dRoll: number, polar: Vec3): Quat {
    this.euler = eulerAfterDrag(this.euler, dragX, dragY);
    this.euler.roll += dRoll;
    this.rotation = rotationFromEuler(this.euler, polar);
    return this.rotation;
  }

  // 画面ドラッグと回転キーで実効回転を回し、書き戻して返す。すべて [rad] で、感度の換算は
  // 呼び出し側が済ませておく。オイラー角は揃えない(rebase() の役目)。
  public turnByDrag(
    dragRight: number, dragUp: number, roll: number, keyYaw: number, keyPitch: number,
  ): Quat {
    const turned = rotateByScreenDrag(this.effective(), dragRight, dragUp, roll, keyYaw, keyPitch);
    this.store(turned);
    return turned;
  }

  // 回し方を切り替える。切り替えた瞬間の向きは変えない。
  public setMode(mode: CameraRotationMode, polar: Vec3): void {
    if (mode === this.mode) return;
    if (mode === 'euler') this.euler = eulerFromRotation(this.rotation, polar);
    else this.rotation = rotationFromEuler(this.euler, polar);
    this.mode = mode;
  }

  // 姿勢追従を始める。保持していた絶対の向きを、対象姿勢からの相対値へ読み替える。
  public beginAttitudeFollow(attitude: Quat, polar: Vec3): void {
    this.rotation = qNormalize(qMul(qInvert(attitude), this.rotation));
    this.attitude = attitude;
    this.following = true;
    this.euler = eulerFromRotation(this.rotation, polar);
  }

  // 姿勢追従を解き、生の値を絶対の向きへ読み替える(掛かっていなければ何もしない)。
  public endAttitudeFollow(polar: Vec3): void {
    if (!this.following) return;
    if (this.attitude !== null) this.rotation = qNormalize(qMul(this.attitude, this.rotation));
    this.following = false;
    this.attitude = null;
    this.euler = eulerFromRotation(this.rotation, polar);
  }

  // 追従の選択だけを差し替える(向きは読み替えない)。初期状態へ戻すときに使い、
  // 追従中に追従へ戻す場合だけ基準の姿勢を持ち越す。
  public restoreFollow(following: boolean): void {
    this.attitude = following && this.following ? this.attitude : null;
    this.following = following;
  }

  // 合成に使う姿勢を最新へ。解決できないフレームは直前の姿勢を保つ(視点が跳ねない)。
  public refreshAttitude(attitude: Quat | null): void {
    if (!this.following || attitude === null) return;
    // 絶対値で持っていた向き(ロード直後)を、初めて引けた姿勢からの相対値へ読み替える。
    if (this.attitude === null) this.rotation = qNormalize(qMul(qInvert(attitude), this.rotation));
    this.attitude = attitude;
  }
}
