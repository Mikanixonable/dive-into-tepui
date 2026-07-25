// 軌道計画モード(マップモード)のカメラと視点操作: マップ地球中心カメラ・
// 太陽回転系表示・フォーカス対象。「マップモード中の視点」の担当で、mapMode 中のみ
// 意味を持つ。フォーカス対象(文字列 focus)はこのクラス自身が持ち、地球中心 or
// ラベル位置への解決も MapMarkers を注入されて自力で行う(呼び出し側は「どこを見る
// か」を一切知らずに済む)。未来ゴーストスライダー(sliderT)はカメラの視点計算に
// 使われないため predictSystem 側の責務 — ここには置かない。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { MouseDelta } from '../input/input';
import { MapMarkers } from './map-markers';
import { FloatingOrigin } from '../floating-origin';
import { ndcToScreen, projectToNdc, ViewFrame } from '../../physics/projection';
import { Frame, RelativeVec3, toFramePos, toInertialPos } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { ProjectFn } from './camera-system';

const WORLD_UP = v3(0, 1, 0);
const MAP_CAMERA_FOV = 50;

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

export class MapCamera {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  readonly camera: THREE.PerspectiveCamera;
  private readonly fov = MAP_CAMERA_FOV;

  // このクラスの正データは cameraFrame 相対で持つ 2 つのベクトルだけ。回転系に「固定」される
  // (回転系の回転に自動追従する)のはこれらが相対座標だから。慣性系(ECI)への変換は frame.ts
  // が一手に引き受け、このクラスは brand を自分で付け外ししない(as を書けば型安全は壊れる)。
  //   offset_r … 注視点 → カメラの相対位置ベクトル(方位・仰角・距離を兼ねる)
  //   pan_r    … focus → 注視点のパン変位。カメラと注視点へ等しく効くので真の平行移動になる
  private offset_r: RelativeVec3;
  private pan_r: RelativeVec3;
  // カメラ視点を固定する座標系(慣性系 / 太陽回転系)。予測軌道を描く座標系
  // (PredictSystem.trajectoryFrame)とは独立で、ユーザーが別々に選べる。切替は set cameraFrame
  // 経由で、そのとき相対座標を新 Frame へ入れ直す。cameraSystem はこのセッターに代入するだけ。
  private _cameraFrame: Frame = 'inertial';
  // update() が受け取った最新の simTime。set cameraFrame が座標変換に使うためキャッシュする。
  private simTime = 0;
  // 注視対象のラベル ID('earth' またはラベル ID)。位置解決は resolveFocus が行う。
  focus = 'earth';

  // update() が相対の正データから算出し sync() が camera へ反映する、絶対 ECI の視点状態。
  position: Vec3 = v3();
  private lookTarget: Vec3 = v3();
  private aspect = window.innerWidth / window.innerHeight;

  // sfx は現状未使用だが、hud/sfx は必ず対で注入する方針のため受け取る(フィールドとしては保持しない)。
  constructor(
    private readonly _hud: Hud,
    _sfx: Sfx,
    private readonly mapMarkers: MapMarkers,
    private readonly ephemeris: Ephemeris,
  ) {
    this.camera = new THREE.PerspectiveCamera(
      MAP_CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      1e4,
      C.MAP_CAMERA_FAR,
    );
    // 初期 Frame は 'inertial' なので toFramePos は恒等変換。ここで brand の付与も frame.ts に任せる。
    this.offset_r = toFramePos(this._cameraFrame, 0, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST), this.ephemeris);
    this.pan_r = toFramePos(this._cameraFrame, 0, v3(), this.ephemeris);
  }

  // 外部(node-gizmo のスクリーンサイズ基準)が参照する注視点 → カメラ距離。長さは回転で不変なので
  // 相対座標の成分からそのまま測れる。
  get dist(): number {
    return Math.hypot(this.offset_r.x, this.offset_r.y, this.offset_r.z);
  }

  // update() が算出した視点状態から直接スクリーン投影する ProjectFn。THREE.js の
  // カメラ行列にもフローティングオリジンにも依存しない(camera-system.ts のコメント参照)。
  get projection(): ProjectFn {
    const view: ViewFrame = {
      position: this.position,
      lookTarget: this.lookTarget,
      up: WORLD_UP,
      fovDeg: this.fov,
      aspect: this.aspect,
    };
    return (worldPos) => ndcToScreen(projectToNdc(view, worldPos), window.innerWidth, window.innerHeight);
  }

  reset(): void {
    this.offset_r = toFramePos(this._cameraFrame, this.simTime, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST), this.ephemeris);
    this.resetPan();
    this.focus = 'earth';
    this._hud.hint('マップ視点をリセット');
  }

  resetPan(): void {
    this.pan_r = toFramePos(this._cameraFrame, this.simTime, v3(), this.ephemeris);
  }

  // focus('earth' またはラベル ID)を絶対 ECI 位置へ解決する(地球中心 = 原点)。
  private resolveFocus(): Vec3 {
    return this.focus === 'earth' ? v3(0, 0, 0) : this.mapMarkers.findLabel(this.focus)?.pos ?? v3(0, 0, 0);
  }

  get cameraFrame(): Frame {
    return this._cameraFrame;
  }

  // 座標系を切り替える。正データ(offset_r・pan_r)を「一度 ECI へ戻してから新 Frame へ」入れ
  // 直すので、切替の瞬間にカメラ視点(ECI)は跳ばず、以後は新 Frame に固定されて追従する。
  // frame.ts の往復だけで済み、方位・仰角は自前で解き直さずに保たれる。
  set cameraFrame(frame: Frame) {
    const from = this._cameraFrame;
    if (frame === from) return;
    const offEci = toInertialPos(from, this.simTime, this.offset_r, this.ephemeris);
    const panEci = toInertialPos(from, this.simTime, this.pan_r, this.ephemeris);
    this.offset_r = toFramePos(frame, this.simTime, offEci, this.ephemeris);
    this.pan_r = toFramePos(frame, this.simTime, panEci, this.ephemeris);
    this._cameraFrame = frame;
  }

  // 毎フレーム、マップカメラの位置・向きをマウス/矢印キー操作から更新する。地球中心の固定
  // 座標系カメラなので自機位置は受け取らない。正データ(offset_r・pan_r)を frame.ts で ECI へ
  // 戻し、操作を通常の Vec3 空間で加えてから、結果を frame.ts で正データへ焼き戻す。この往復に
  // 挟まれた操作部は brand を意識しないただの Vec3 計算になる。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    simTime: number,
  ): void {
    this.simTime = simTime;
    const focus = this.resolveFocus();
    // 正データを現在時刻の ECI へ戻す。以降の操作はすべてこの Vec3 に対して行う。
    let offEci = toInertialPos(this._cameraFrame, simTime, this.offset_r, this.ephemeris);
    let panEci = toInertialPos(this._cameraFrame, simTime, this.pan_r, this.ephemeris);

    // 方位・仰角・距離を offEci から解いて操作を加え、組み直す。回転軸は Y なので仰角 pitch は
    // frame と ECI で不変(offEci.y の成分はどちらでも同じ)。戦闘ビューは yaw -= dx*0.005 なので
    // 符号を反転させて左右の回転方向を揃える。
    const dist = Math.max(C.MAP_MIN_DIST, Math.min(C.MAP_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0012)));
    const dir = norm(offEci);
    const yaw = Math.atan2(dir.z, dir.x) + mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    const pitch = Math.max(-1.4, Math.min(1.4,
      Math.asin(Math.max(-1, Math.min(1, dir.y))) + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt,
    ));
    offEci = sphericalOffset(yaw, pitch, dist);

    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      // ピクセル → マップ世界メートル変換。THREE の lookAt(up=+Y) が作る基底と一致する
      // カメラ右/上ベクトルを注視方向から組み、pan(カメラと注視点を等しく動かす真の平行移動)へ加える。
      const viewDir = scale(norm(offEci), -1);
      const right = norm(cross(viewDir, WORLD_UP));
      const camUp = norm(cross(right, viewDir));
      const metersPerPixel =
        (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.fov * 0.5))) / Math.max(1, window.innerHeight);
      panEci = addScaled(panEci, right, -mouse.panDx * metersPerPixel);
      panEci = addScaled(panEci, camUp, mouse.panDy * metersPerPixel);
    }

    // ECI で視点を確定し、操作結果を正データ(cameraFrame 相対)へ焼き戻す。
    this.lookTarget = add(focus, panEci);
    this.position = add(this.lookTarget, offEci);
    this.offset_r = toFramePos(this._cameraFrame, simTime, offEci, this.ephemeris);
    this.pan_r = toFramePos(this._cameraFrame, simTime, panEci, this.ephemeris);
    this.aspect = window.innerWidth / window.innerHeight;
  }

  // update() で算出した絶対 ECI の視点状態を fo 経由で描画フレームへ変換して camera に反映する。
  sync(fo: FloatingOrigin): void {
    const camera = this.camera;
    camera.position.copy(fo.RtoThreeV3(this.position));
    camera.up.set(0, 1, 0);
    camera.lookAt(fo.RtoThreeV3(this.lookTarget));
    if (Math.abs(camera.aspect - this.aspect) > 1e-6) {
      camera.aspect = this.aspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }
}
