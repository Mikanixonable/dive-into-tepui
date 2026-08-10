// マップモードの地球中心広範囲視点カメラ。太陽回転系への切替とフォーカス対象の選択を持つ。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, dot, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { MouseDelta } from '../input/input';
import { Viewpoint } from '../../physics/projection';
import { ReferenceFrame, FrameDir, toFrameDir, toInertialDir, toInertialPoint } from '../../physics/frame';
import { OrbitingId } from '../../physics/attractor';
import type { Ephemeris } from '../../physics/ephemeris';
import { qFromAxisAngle, qRotate } from '../../physics/attitude';
import { MapPickable } from '../map-pick';
import { Attractor } from '../../physics/attractor';
import { bodyDef } from '../../physics/solar-system';
import { FocusTarget } from './focus-target';

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
  private _cameraFrame: ReferenceFrame;
  private simTime = 0; // set cameraFrame の座標変換に使う
  // 最新の update 呼び出しが受け取った重力源一覧。reset/resetPan/cameraFrame setter は
  // フレームの外(入力ハンドラ)から呼ばれるため、update と同じ値をここから読む。
  private attractors: readonly Attractor[] = [];
  private _focus: FocusTarget;
  private missingFocusFrames = 0;
  private lastResolvedFocus = v3();

  get focus(): FocusTarget { return this._focus; }

  // target が 'point'(座標系に焼き込んだ固定点)で frame が回転系なら、その天体の
  // 公転に追随する固定点になる。
  setFocusTarget(target: FocusTarget, resetPan = true): void {
    this._focus = target;
    this.missingFocusFrames = 0;
    if (resetPan) this.resetPan();
  }

  clearFocusIf(id: string): void {
    if (this._focus.kind === 'object' && this._focus.id === id) {
      this.setFocusTarget({ kind: 'object', id: this.ephemeris.originId });
    }
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
    this._cameraFrame = ephemeris.inertialFrame;
    this._focus = { kind: 'object', id: ephemeris.originId };
    const tf0 = this.ephemeris.frameTransformAt(this._cameraFrame, 0, []);
    this.offset_r = toFrameDir(tf0, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST));
    this.pan_r = toFrameDir(tf0, v3());
    this.up_r = toFrameDir(tf0, WORLD_UP);
    this.camera = new THREE.PerspectiveCamera(
      OVERVIEW_CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      this.near,
      this.far,
    );
  }

  // 注視点からカメラまでの距離を返す。
  get dist(): number {
    return Math.hypot(this.offset_r.x, this.offset_r.y, this.offset_r.z);
  }

  // CameraSystem.sync が読む近クリップ距離。dist に比例させることで、どのズーム段でも
  // 注視点を切り落とさずに深度分解能を保つ(OVERVIEW_CAMERA_NEAR_RATIO 参照)。
  // near クリップは光軸からの角度 θ の点を R·cosθ で切り詰める平面なので、画面対角の
  // 半視野角(fov・aspect から求まる)での R·cosθ_diag を超えないようクランプし、
  // 星球シェル・天球グリッドの周辺・四隅がクリップされないようにする。
  get near(): number {
    const halfV = THREE.MathUtils.degToRad(this.fov * 0.5);
    const halfH = Math.atan(Math.tan(halfV) * window.innerWidth / window.innerHeight);
    const halfDiag = Math.atan(Math.hypot(Math.tan(halfV), Math.tan(halfH)));
    const nearMax = C.CELESTIAL_SHELL_RADIUS * Math.cos(halfDiag) * C.OVERVIEW_CAMERA_NEAR_SHELL_MARGIN;
    return Math.min(nearMax, this.dist / C.OVERVIEW_CAMERA_NEAR_RATIO);
  }

  // CameraSystem.sync が読む遠クリップ距離。dist に比例させることで、引いたカメラでも
  // 太陽・木星のような遠方天体が far の外に出て消えない(OVERVIEW_CAMERA_FAR_RATIO 参照)。
  get far(): number {
    return Math.min(C.OVERVIEW_CAMERA_FAR_MAX, Math.max(C.OVERVIEW_CAMERA_FAR_MIN, this.dist * C.OVERVIEW_CAMERA_FAR_RATIO));
  }

  // 現在のフォーカス対象がクランプ後も表面下にめり込まない最小注視距離。
  // フォーカスが天体でなければ通常の下限をそのまま使う。
  private get minDist(): number {
    if (this._focus.kind !== 'object' || !(this._focus.id in this.ephemeris.registry)) return C.OVERVIEW_CAMERA_MIN_DIST;
    return Math.max(C.OVERVIEW_CAMERA_MIN_DIST, bodyDef(this.ephemeris.registry, this._focus.id).radius);
  }

  // カメラのロールのみを初期状態(ワールド上方)に戻す。
  reset(): void {
    this.up_r = toFrameDir(this.ephemeris.frameTransformAt(this._cameraFrame, this.simTime, this.attractors), WORLD_UP);
    this._hud.hint('マップ視点のロールをリセット');
  }

  // パン変位をゼロに戻す。
  resetPan(): void {
    this.pan_r = toFrameDir(this.ephemeris.frameTransformAt(this._cameraFrame, this.simTime, this.attractors), v3());
  }

  // 候補が一時的に欠けたフレームでは直前の注視点を保ち、連続して消えた対象は ECI 原点へ戻す。
  // point は座標系が回っていれば ECI 座標が動くため、毎フレーム焼き直す。
  private resolveFocus(candidates: readonly MapPickable[], simTime: number, attractors: readonly Attractor[]): Vec3 {
    const focus = this._focus;
    if (focus.kind === 'point') {
      const tf = this.ephemeris.frameTransformAt(focus.frame, simTime, attractors);
      this.lastResolvedFocus = toInertialPoint(tf, focus.point);
      return this.lastResolvedFocus;
    }
    if (focus.id === this.ephemeris.originId) {
      this.missingFocusFrames = 0;
      this.lastResolvedFocus = v3();
      return this.lastResolvedFocus;
    }
    const candidate = candidates.find((c) => c.id === focus.id);
    if (candidate) {
      this.missingFocusFrames = 0;
      this.lastResolvedFocus = candidate.pos;
      return candidate.pos;
    }
    this.missingFocusFrames++;
    if (this.missingFocusFrames >= 2) {
      this.setFocusTarget({ kind: 'object', id: this.ephemeris.originId });
      return v3();
    }
    return this.lastResolvedFocus;
  }

  // 現在視点を固定している座標系を返す。
  get cameraFrame(): ReferenceFrame {
    return this._cameraFrame;
  }

  // 最後に resolveFocus が解決した注視点の ECI 位置。
  get resolvedFocus(): Vec3 {
    return this.lastResolvedFocus;
  }

  // カメラ視点の回転対象を切り替える。中心は常に ephemeris.originId — offset_r/pan_r/up_r は
  // 方向(FrameDir)しか持たず原点移動の影響を受けないので、中心をどれにしても視点は変わらない。
  // 切替の瞬間にカメラ視点(ECI)を跳ばせないよう、現在の座標系から新しい座標系へ変換し直す。
  setCameraRotation(rotatingWith: OrbitingId | null): void {
    const frame = this.ephemeris.frameOf(this.ephemeris.originId, rotatingWith);
    const from = this._cameraFrame;
    if (frame === from) return;
    const tfFrom = this.ephemeris.frameTransformAt(from, this.simTime, this.attractors);
    const offEci = toInertialDir(tfFrom, this.offset_r);
    const panEci = toInertialDir(tfFrom, this.pan_r);
    const upEci = toInertialDir(tfFrom, this.up_r);
    const tfTo = this.ephemeris.frameTransformAt(frame, this.simTime, this.attractors);
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
    attractors: readonly Attractor[],
  ): void {
    this.simTime = simTime;
    this.attractors = attractors;
    const focus = this.resolveFocus(candidates, simTime, attractors);
    const tf = this.ephemeris.frameTransformAt(this._cameraFrame, simTime, attractors);
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
