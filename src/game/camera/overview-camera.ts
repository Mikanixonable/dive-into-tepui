// マップモードの地球中心広範囲視点カメラ。太陽回転系への切替とフォーカス対象の選択を持つ。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { MouseDelta } from '../input/input';
import { FocusMarkers } from './focus-markers';
import { ViewFrame } from '../../physics/projection';
import { Frame, RelativeVec3, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';

const WORLD_UP = v3(0, 1, 0);
const OVERVIEW_CAMERA_FOV = 50;

// 初期視点(注視点まわりの方位角・仰角・距離)。offset_r の初期値の組み立てにだけ使う。
const INIT_YAW = 0.7;
const INIT_PITCH = 0.45;
const INIT_DIST = 4.5e7;

// 注視点 → カメラの相対位置ベクトルを、方位角・仰角・距離から組む。回転軸 Y まわりの
// 方位 yaw と、そこからの仰角 pitch。update()/初期化の両方で使う純粋関数。
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
  private offset_r: RelativeVec3;
  private pan_r: RelativeVec3;
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
    private readonly focusMarkers: FocusMarkers,
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
  }

  // 注視点からカメラまでの距離を返す。
  get dist(): number {
    return Math.hypot(this.offset_r.x, this.offset_r.y, this.offset_r.z);
  }

  // 視点・パン・フォーカスを初期状態に戻す。
  reset(): void {
    this.offset_r = toFramePos(this._cameraFrame, this.simTime, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST), this.ephemeris);
    this.resetPan();
    this.focus = 'earth';
    this._hud.hint('マップ視点をリセット');
  }

  // パン変位をゼロに戻す。
  resetPan(): void {
    this.pan_r = toFramePos(this._cameraFrame, this.simTime, v3(), this.ephemeris);
  }

  // 現在のフォーカス対象の ECI 位置を返す。'earth' なら原点。
  private resolveFocus(): Vec3 {
    return this.focus === 'earth' ? v3(0, 0, 0) : this.focusMarkers.findLabel(this.focus)?.pos ?? v3(0, 0, 0);
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
    this.offset_r = toFramePos(frame, this.simTime, offEci, this.ephemeris);
    this.pan_r = toFramePos(frame, this.simTime, panEci, this.ephemeris);
    this._cameraFrame = frame;
  }

  // マウス/キー入力から view を1フレーム分更新する。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    simTime: number,
  ): void {
    this.simTime = simTime;
    const focus = this.resolveFocus();
    let offEci = toInertialPos(this._cameraFrame, simTime, this.offset_r, this.ephemeris);
    let panEci = toInertialPos(this._cameraFrame, simTime, this.pan_r, this.ephemeris);

    // ホイール/ドラッグから距離・方位角・仰角を更新する
    const dist = Math.max(C.OVERVIEW_CAMERA_MIN_DIST,
      Math.min(C.OVERVIEW_CAMERA_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0012)));
    const dir = norm(offEci);
    const yaw = Math.atan2(dir.z, dir.x) + mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    const pitch = Math.max(-1.4, Math.min(1.4,
      Math.asin(Math.max(-1, Math.min(1, dir.y))) + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt,
    ));
    offEci = sphericalOffset(yaw, pitch, dist);

    // 中ボタンドラッグ/2本指ドラッグでパン変位を更新する
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      const viewDir = scale(norm(offEci), -1);
      const right = norm(cross(viewDir, WORLD_UP));
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
      up: WORLD_UP,
      fovDeg: this.fov,
      aspect: window.innerWidth / window.innerHeight,
    };
    this.offset_r = toFramePos(this._cameraFrame, simTime, offEci, this.ephemeris);
    this.pan_r = toFramePos(this._cameraFrame, simTime, panEci, this.ephemeris);
  }
}
