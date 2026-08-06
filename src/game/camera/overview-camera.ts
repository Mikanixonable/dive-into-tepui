// マップモードの地球中心広範囲視点カメラ。太陽回転系への切替とフォーカス対象の選択を持つ。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, dot, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { MouseDelta } from '../input/input';
import { ViewFrame } from '../../physics/projection';
import { Frame, RelativeVec3, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { qFromAxisAngle, qRotate } from '../../physics/attitude';
import { MapPickable } from '../map-pick';

const WORLD_UP = v3(0, 1, 0);
const OVERVIEW_CAMERA_FOV = 50;

// 初期視点(注視点まわりの方位角・仰角・距離)。offset_r の初期値の組み立てにだけ使う。
const INIT_YAW = 0.7;
const INIT_PITCH = 0.45;
const INIT_DIST = 4.5e7;

// 注視点 → カメラの相対位置ベクトルを、方位角・仰角・距離から組む。回転軸 Y まわりの
// 方位 yaw と、そこからの仰角 pitch。初期状態の視点を名前の付いた角度で置くための純粋関数。
function sphericalOffset(yaw: number, pitch: number, dist: number): Vec3 {
  const cp = Math.cos(pitch);
  return scale(v3(cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)), dist);
}

export class OverviewCamera {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  readonly camera: THREE.PerspectiveCamera;
  private readonly fov = OVERVIEW_CAMERA_FOV;

  // offset_r … 注視点 → カメラの相対位置ベクトル(方位・仰角・距離を兼ねる)
  // pan_r    … focus → 注視点のパン変位
  // up_r     … カメラの上方向(テンキー0/1のロールで offset_r まわりに回る)
  private offset_r: RelativeVec3;
  private pan_r: RelativeVec3;
  private up_r: RelativeVec3;
  // カメラ視点を固定する座標系(慣性系 / 太陽回転系)。
  private _cameraFrame: Frame = 'inertial';
  private simTime = 0; // set cameraFrame の座標変換に使う
  focus = 'earth'; // 注視対象のラベル ID

  view: ViewFrame = {
    position: v3(),
    lookTarget: v3(),
    up: WORLD_UP,
    fovDeg: OVERVIEW_CAMERA_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };

  // THREE.PerspectiveCamera と初期視点(offset_r/pan_r)を組む。
  constructor(
    private readonly _hud: Hud,
    _sfx: Sfx,
    private readonly ephemeris: Ephemeris,
  ) {
    this.camera = new THREE.PerspectiveCamera(
      OVERVIEW_CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      1e4,
      C.OVERVIEW_CAMERA_FAR,
    );
    this.offset_r = toFramePos(this._cameraFrame, 0, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST), this.ephemeris);
    this.pan_r = toFramePos(this._cameraFrame, 0, v3(), this.ephemeris);
    this.up_r = toFramePos(this._cameraFrame, 0, WORLD_UP, this.ephemeris);
  }

  // 注視点からカメラまでの距離を返す。
  get dist(): number {
    return Math.hypot(this.offset_r.x, this.offset_r.y, this.offset_r.z);
  }

  // 視点とパンを初期状態に戻す。フォーカス対象は維持する。
  // 地球以外の天体や航法ポイントを見ている場合、リセット操作で地球へ
  // 戻すとユーザーの意図した対象を失うため、focus はここでは変更しない。
  reset(): void {
    this.offset_r = toFramePos(this._cameraFrame, this.simTime, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST), this.ephemeris);
    this.resetPan();
    this.up_r = toFramePos(this._cameraFrame, this.simTime, WORLD_UP, this.ephemeris);
    this._hud.hint('マップ視点をリセット');
  }

  // パン変位をゼロに戻す。
  resetPan(): void {
    this.pan_r = toFramePos(this._cameraFrame, this.simTime, v3(), this.ephemeris);
  }

  // 現在のフォーカス対象の ECI 位置を返す。'earth' または candidates に見当たらなければ原点。
  private resolveFocus(candidates: readonly MapPickable[]): Vec3 {
    if (this.focus === 'earth') return v3(0, 0, 0);
    return candidates.find((c) => c.id === this.focus)?.pos ?? v3(0, 0, 0);
  }

  // 現在視点を固定している座標系を返す。
  get cameraFrame(): Frame {
    return this._cameraFrame;
  }

  // 切替の瞬間にカメラ視点(ECI)を跳ばせずに座標系を切り替える。
  set cameraFrame(frame: Frame) {
    const from = this._cameraFrame;
    if (frame === from) return;
    const offEci = toInertialPos(from, this.simTime, this.offset_r, this.ephemeris);
    const panEci = toInertialPos(from, this.simTime, this.pan_r, this.ephemeris);
    const upEci = toInertialPos(from, this.simTime, this.up_r, this.ephemeris);
    this.offset_r = toFramePos(frame, this.simTime, offEci, this.ephemeris);
    this.pan_r = toFramePos(frame, this.simTime, panEci, this.ephemeris);
    this.up_r = toFramePos(frame, this.simTime, upEci, this.ephemeris);
    this._cameraFrame = frame;
  }

  // マウス/キー入力から view を1フレーム分更新する。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    keyRoll: number,
    dt: number,
    simTime: number,
    candidates: readonly MapPickable[],
  ): void {
    this.simTime = simTime;
    const focus = this.resolveFocus(candidates);
    let offEci = toInertialPos(this._cameraFrame, simTime, this.offset_r, this.ephemeris);
    let panEci = toInertialPos(this._cameraFrame, simTime, this.pan_r, this.ephemeris);
    let upEci = toInertialPos(this._cameraFrame, simTime, this.up_r, this.ephemeris);

    // ホイールで距離を、ドラッグ/キーで視点方向を更新する。ヨー/ピッチはワールド軸ではなく
    // 現在の上/右軸まわりに回す — ロールで上方向が傾いても、画面上の動きと入力方向が一致する。
    // マップビューはトラックパッドの細かいスクロールでも操作しやすいよう、
    // スクロールによるズーム感度を combat の基準値から 1.5 倍にする。
    const dist = Math.max(C.OVERVIEW_CAMERA_MIN_DIST,
      Math.min(C.OVERVIEW_CAMERA_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0018)));
    upEci = norm(addScaled(upEci, offEci, -dot(upEci, offEci) / dot(offEci, offEci)));
    const yaw = mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    const pitch = mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt;
    if (yaw !== 0) offEci = qRotate(qFromAxisAngle(upEci, -yaw), offEci);
    const right = norm(cross(norm(offEci), upEci));
    if (pitch !== 0) {
      const q = qFromAxisAngle(right, pitch);
      offEci = qRotate(q, offEci);
      upEci = qRotate(q, upEci);
    }
    offEci = scale(norm(offEci), dist);

    // 視点方向が変わったぶん上方向を再直交化してから、視線軸まわりにロールを加える。
    const newDir = norm(offEci);
    upEci = norm(addScaled(upEci, newDir, -dot(upEci, newDir)));
    if (keyRoll !== 0) upEci = qRotate(qFromAxisAngle(newDir, keyRoll * C.CAM_KEY_ROLL_RATE * dt), upEci);

    // 中ボタンドラッグ/2本指ドラッグでパン変位を更新する
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      const viewDir = scale(newDir, -1);
      const right = norm(cross(viewDir, upEci));
      const camUp = norm(cross(right, viewDir));
      const metersPerPixel =
        (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.fov * 0.5))) / Math.max(1, window.innerHeight);
      panEci = addScaled(panEci, right, -mouse.panDx * metersPerPixel);
      panEci = addScaled(panEci, camUp, mouse.panDy * metersPerPixel);
    }

    // フォーカス+パン+視点オフセットから実位置を組み立てる
    const lookTarget = add(focus, panEci);
    this.view = {
      position: add(lookTarget, offEci),
      lookTarget,
      up: upEci,
      fovDeg: this.fov,
      aspect: window.innerWidth / window.innerHeight,
    };
    this.up_r = toFramePos(this._cameraFrame, simTime, upEci, this.ephemeris);
    this.offset_r = toFramePos(this._cameraFrame, simTime, offEci, this.ephemeris);
    this.pan_r = toFramePos(this._cameraFrame, simTime, panEci, this.ephemeris);
  }
}
