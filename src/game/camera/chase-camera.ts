// 追従対象を中心とした三人称軌道視点。姿勢は単位クオータニオン(rot)と距離(dist)だけで持つ。
// rot の意味は camFollowAttitude で切り替わる: true なら対象の姿勢に対する相対姿勢、false なら
// ワールド(ECI)に対する絶対姿勢。切り替えは toggleFollowAttitude が対象の姿勢クオータニオンを
// 掛け/割って読み替える。
import { add, addScaled, cross, len, norm, scale, v3, Vec3 } from '../../physics/vec3';
import { MouseDelta } from '../input/input';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Quat, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate } from '../../physics/attitude';
import { metersPerPixelAtDepth, Viewpoint } from '../../physics/projection';
import { ChaseCameraSaveData } from '../save-data';

// ChaseCamera が対象から要る最小限の形 — 中心位置と、camFollowAttitude の基準になる姿勢だけ。
// GameEntity はもちろん、実体を持たない組立対象(下書き・格納中の艦)も呼び出し側がこの形へ
// 変換して渡せる(PlanExecutorShip/CapabilityVessel と同じ、狭い構造的インターフェースの流儀)。
export interface ChaseCameraTarget {
  readonly position: Vec3;
  readonly attitude: Quat;
}

// 初期視点: 機体後方やや上から見下ろす。
const DEFAULT_ROT: Quat = qFromAxisAngle(v3(1, 0, 0), 0.3 - (10 * Math.PI) / 180);
const DEFAULT_DIST = 38;
// dist の可動範囲。update() が毎フレーム掛ける他、対象の外接半径から直接 dist を代入する
// 呼び出し側(Docking の組立カメラ寄せ)もこの範囲へ収める。
export const CHASE_DIST_MIN = 12;
export const CHASE_DIST_MAX = 8000;

export class ChaseCamera {
  private rot: Quat = DEFAULT_ROT;
  dist = DEFAULT_DIST;
  private _camFollowAttitude = true;
  private panEci: Vec3 = v3(0, 0, 0);

  viewpoint: Viewpoint = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: C.BASE_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  // saved があればその状態から組む。rot はセーブ時点の基準フレーム(機体姿勢基準/ワールド基準)
  // での値のまま代入する — toggleFollowAttitude は基準の切替時に rot を読み替えるため、
  // 経由すると意味が変わってしまう。
  constructor(
    private readonly _hud: Hud,
    saved?: ChaseCameraSaveData,
  ) {
    if (saved) {
      this.rot = qNormalize({ x: saved.rot.x, y: saved.rot.y, z: saved.rot.z, w: saved.rot.w });
      this.dist = saved.dist;
      this.panEci = v3(saved.pan.x, saved.pan.y, saved.pan.z);
      this._camFollowAttitude = saved.followAttitude;
    }
  }

  // ワールド基準として持っている rot を、同じ向きを指す対象の姿勢基準の値へ読み替える。
  private rotInTargetFrame(target: ChaseCameraTarget): Quat {
    return qNormalize(qMul(qInvert(target.attitude), this.rot));
  }

  // 対象の姿勢基準として持っている rot を、同じ向きを指すワールド基準の値へ読み替える。
  private rotInWorldFrame(target: ChaseCameraTarget): Quat {
    return qNormalize(qMul(target.attitude, this.rot));
  }

  // 視点の基準フレーム(対象の姿勢基準 true ⇔ ワールド基準 false)。
  get camFollowAttitude(): boolean {
    return this._camFollowAttitude;
  }

  // 視点を初期状態にリセットする
  reset(): void {
    this.rot = DEFAULT_ROT;
    this.dist = DEFAULT_DIST;
    this.panEci = v3(0, 0, 0);
  }

  // 視点の基準フレーム(機体姿勢基準 ⇔ ワールド基準)を切り替える。切替の瞬間に見えている向きが
  // 変わらないよう rot を新しい基準での値へ読み替えるので、読み替えの基準となる対象が要る。
  toggleFollowAttitude(target: ChaseCameraTarget | null): void {
    if (!target) return;
    const next = !this._camFollowAttitude;
    this.rot = next ? this.rotInTargetFrame(target) : this.rotInWorldFrame(target);
    this._camFollowAttitude = next;
    this.panEci = v3(0, 0, 0); // フレーム切替時に座標系不辺によるパンジャンプを防ぐ
    this._hud.hint(
      `視点のRCS追従: ${next ? 'ON (視点が機体姿勢に追従)' : 'OFF (ワールド基準の独立視点)'}`,
    );
  }

  // キー/マウス入力から rot/dist を更新し、対象の状態から viewpoint を組み直す。target が
  // null なら(操作対象艦が居ない)何もせず、viewpoint は直前の値のまま凍結する。
  update(
    mouse: MouseDelta, keyYaw: number, keyPitch: number, dt: number,
    target: ChaseCameraTarget | null,
  ): void {
    if (!target) return;
    let q = this._camFollowAttitude ? qMul(target.attitude, this.rot) : this.rot;

    const right = qRotate(q, v3(1, 0, 0));
    const up = qRotate(q, v3(0, 1, 0));
    const view = qRotate(q, v3(0, 0, 1));

    if (keyYaw !== 0) q = qMul(qFromAxisAngle(up, -keyYaw * C.CAM_KEY_YAW_RATE * dt), q);
    if (keyPitch !== 0) q = qMul(qFromAxisAngle(right, keyPitch * C.CAM_KEY_PITCH_RATE * dt), q);
    if (mouse.roll !== 0) q = qMul(qFromAxisAngle(view, mouse.roll), q);

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
    this.dist = Math.max(CHASE_DIST_MIN, Math.min(CHASE_DIST_MAX, this.dist));

    // 中ボタンドラッグ等によるパン変位
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      const metersPerPixel = metersPerPixelAtDepth(C.BASE_FOV, this.dist, Math.max(1, window.innerHeight));
      this.panEci = addScaled(this.panEci, right, mouse.panDx * metersPerPixel);
      this.panEci = addScaled(this.panEci, up, mouse.panDy * metersPerPixel);
    }

    this.rot = this._camFollowAttitude ? qNormalize(qMul(qInvert(target.attitude), q)) : q;

    const center = target.position;
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
