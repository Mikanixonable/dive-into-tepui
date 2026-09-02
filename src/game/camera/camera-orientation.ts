// カメラの向きを、クォータニオンと極軸まわりのオイラー角の二表現で保つ。どちらから書き換えても
// 両方が同じ向きを指すこと、姿勢追従中の生の値が対象姿勢からの相対値であることは、この中だけで
// 担保する。**極軸の選び方は持たない** — 天体から選ぶのはカメラの仕事なので、書き換えのたびに
// 受け取る。
import { Quat, qInvert, qMul, qNormalize } from '../../math/quat';
import {
  POLAR_PITCH_LIMIT, PolarEuler, eulerFromRotation, rotationFromEuler,
} from '../../math/orientation';
import type { Vec3 } from '../../math/vec3';

// 視点の回し方。オイラーは極軸を天頂とした方位・仰角で、クォータニオンは画面基準で回す。
export type CameraRotationMode = 'quaternion' | 'euler';

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

  // オイラー角へ増分を積み、組み直した向きを返す。仰角は真上・真下の手前で止める。
  public turn(dYaw: number, dPitch: number, dRoll: number, polar: Vec3): Quat {
    this.euler.yaw += dYaw;
    this.euler.pitch = Math.max(-POLAR_PITCH_LIMIT, Math.min(POLAR_PITCH_LIMIT, this.euler.pitch + dPitch));
    this.euler.roll += dRoll;
    this.rotation = rotationFromEuler(this.euler, polar);
    return this.rotation;
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
