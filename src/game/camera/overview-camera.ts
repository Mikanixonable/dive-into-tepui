// マップモードの地球中心広範囲視点カメラ。太陽回転系への切替とフォーカス対象の選択を持つ。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, dot, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { MouseDelta } from '../input/input';
import { Viewpoint } from '../../physics/projection';
import { ReferenceFrame, FrameDir, INERTIAL_FRAME, toFrameDir, toInertialDir } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { qFromAxisAngle, qRotate } from '../../physics/attitude';
import { MapPickable } from '../map-pick';
import { bodyDef, SOLAR_SYSTEM } from '../../physics/solar-system';
import { AttractorId } from '../../physics/attractor';

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
  private offset_r: FrameDir;
  private pan_r: FrameDir;
  private up_r: FrameDir;
  // カメラ視点を固定する座標系。
  private _cameraFrame: ReferenceFrame = INERTIAL_FRAME;
  private simTime = 0; // set cameraFrame の座標変換に使う
  private _focus = 'earth';
  private _focusPos: Vec3 | null = null;
  private missingFocusFrames = 0;
  private lastResolvedFocus = v3();

  get focus(): string { return this._focus; }

  setFocus(id: string, resetPan = true): void {
    this._focus = id;
    this._focusPos = null;
    this.missingFocusFrames = 0;
    if (resetPan) this.resetPan();
  }

  setFocusPos(pos: Vec3, resetPan = true): void {
    this._focus = '';
    this._focusPos = pos;
    this.missingFocusFrames = 0;
    if (resetPan) this.resetPan();
  }

  clearFocusIf(id: string): void {
    if (this._focus === id) this.setFocus('earth');
  }

  viewpoint: Viewpoint = {
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
    const tf0 = this.ephemeris.frameTransformAt(this._cameraFrame, 0);
    this.offset_r = toFrameDir(tf0, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST));
    this.pan_r = toFrameDir(tf0, v3());
    this.up_r = toFrameDir(tf0, WORLD_UP);
    this.camera = new THREE.PerspectiveCamera(
      OVERVIEW_CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      this.near,
      C.OVERVIEW_CAMERA_FAR,
    );
  }

  // 注視点からカメラまでの距離を返す。
  get dist(): number {
    return Math.hypot(this.offset_r.x, this.offset_r.y, this.offset_r.z);
  }

  // CameraSystem.sync が読む近クリップ距離。dist に比例させることで、どのズーム段でも
  // 注視点を切り落とさずに深度分解能を保つ(OVERVIEW_CAMERA_NEAR_RATIO 参照)。
  get near(): number {
    return this.dist / C.OVERVIEW_CAMERA_NEAR_RATIO;
  }

  // 現在のフォーカス対象がクランプ後も表面下にめり込まない最小注視距離。
  // フォーカスが天体でなければ通常の下限をそのまま使う。
  private get minDist(): number {
    if (!(this._focus in SOLAR_SYSTEM)) return C.OVERVIEW_CAMERA_MIN_DIST;
    return Math.max(C.OVERVIEW_CAMERA_MIN_DIST, bodyDef(this._focus as AttractorId).radius);
  }

  // カメラのロールのみを初期状態(ワールド上方)に戻す。
  reset(): void {
    this.up_r = toFrameDir(this.ephemeris.frameTransformAt(this._cameraFrame, this.simTime), WORLD_UP);
    this._hud.hint('マップ視点のロールをリセット');
  }

  // パン変位をゼロに戻す。
  resetPan(): void {
    this.pan_r = toFrameDir(this.ephemeris.frameTransformAt(this._cameraFrame, this.simTime), v3());
  }

  // 候補が一時的に欠けたフレームでは直前の注視点を保ち、連続して消えた対象は地球へ戻す。
  private resolveFocus(candidates: readonly MapPickable[]): Vec3 {
    if (this._focusPos) {
      this.lastResolvedFocus = this._focusPos;
      return this._focusPos;
    }
    if (this._focus === 'earth') {
      this.missingFocusFrames = 0;
      this.lastResolvedFocus = v3();
      return this.lastResolvedFocus;
    }
    const candidate = candidates.find((c) => c.id === this._focus);
    if (candidate) {
      this.missingFocusFrames = 0;
      this.lastResolvedFocus = candidate.pos;
      return candidate.pos;
    }
    this.missingFocusFrames++;
    if (this.missingFocusFrames >= 2) {
      this.setFocus('earth');
      return v3();
    }
    return this.lastResolvedFocus;
  }

  // 現在視点を固定している座標系を返す。
  get cameraFrame(): ReferenceFrame {
    return this._cameraFrame;
  }

  // 切替の瞬間にカメラ視点(ECI)を跳ばせずに座標系を切り替える。
  set cameraFrame(frame: ReferenceFrame) {
    const from = this._cameraFrame;
    if (frame === from) return;
    const tfFrom = this.ephemeris.frameTransformAt(from, this.simTime);
    const offEci = toInertialDir(tfFrom, this.offset_r);
    const panEci = toInertialDir(tfFrom, this.pan_r);
    const upEci = toInertialDir(tfFrom, this.up_r);
    const tfTo = this.ephemeris.frameTransformAt(frame, this.simTime);
    this.offset_r = toFrameDir(tfTo, offEci);
    this.pan_r = toFrameDir(tfTo, panEci);
    this.up_r = toFrameDir(tfTo, upEci);
    this._cameraFrame = frame;
  }

  // マウス/キー入力から viewpoint を1フレーム分更新する。
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
    const tf = this.ephemeris.frameTransformAt(this._cameraFrame, simTime);
    let offEci = toInertialDir(tf, this.offset_r);
    let panEci = toInertialDir(tf, this.pan_r);
    let upEci = toInertialDir(tf, this.up_r);

    // ホイールで距離を、ドラッグ/キーで視点方向を更新する。ヨー/ピッチはワールド軸ではなく
    // 現在の上/右軸まわりに回す — ロールで上方向が傾いても、画面上の動きと入力方向が一致する。
    // マップビューはトラックパッドの細かいスクロールでも操作しやすいよう、
    // スクロールによるズーム感度を combat の基準値から 1.5 倍にする。
    const dist = Math.max(this.minDist,
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
    this.viewpoint = {
      position: add(lookTarget, offEci),
      lookTarget,
      up: upEci,
      fovDeg: this.fov,
      aspect: window.innerWidth / window.innerHeight,
    };
    this.up_r = toFrameDir(tf, upEci);
    this.offset_r = toFrameDir(tf, offEci);
    this.pan_r = toFrameDir(tf, panEci);
  }
}
