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

export class MapCamera {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  readonly camera: THREE.PerspectiveCamera;
  private readonly fov = MAP_CAMERA_FOV;
  // yaw/pitch/dist/pan は cameraFrame 相対のカメラ座標(注視点まわりの方位角・仰角・距離・
  // パン変位)。この相対座標を「固定」して保持するのがこのクラスの本質的な責務で、慣性系(ECI)
  // への変換は update() が frame.ts 経由で行う(sunAz などの合成はここでは一切しない)。
  yaw = 0.7;
  pitch = 0.45;
  dist = 4.5e7;
  // cameraFrame 相対のパン変位 [m]。カメラと注視点へ等しく加えるので真の平行移動になる。
  pan: Vec3 = v3();
  // カメラ視点を固定する座標系(慣性系 / 太陽回転系)。切替は set cameraFrame 経由で、
  // そのとき相対座標を新 Frame へ入れ直す。plan-system はこのセッターに代入するだけ。
  private _cameraFrame: Frame = 'inertial';
  // update() が受け取った最新の simTime。set cameraFrame が座標変換に使うためキャッシュする。
  private simTime = 0;
  // 注視対象のラベル ID('earth' またはラベル ID)。位置解決は resolveFocus が行う。
  focus = 'earth';

  // update() が cameraFrame 相対座標から算出し sync() が camera へ反映する、絶対 ECI の視点状態。
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
    this.yaw = 0.7;
    this.pitch = 0.45;
    this.dist = 4.5e7;
    this.resetPan();
    this.focus = 'earth';
    this._hud.hint('マップ視点をリセット');
  }

  resetPan(): void {
    this.pan = v3();
  }

  // focus('earth' またはラベル ID)を絶対 ECI 位置へ解決する(地球中心 = 原点)。
  private resolveFocus(): Vec3 {
    return this.focus === 'earth' ? v3(0, 0, 0) : this.mapMarkers.findLabel(this.focus)?.pos ?? v3(0, 0, 0);
  }

  // cameraFrame 相対の方位角・仰角から、注視点 → カメラ方向の単位ベクトル(相対座標)を組む。
  private offsetDir(): Vec3 {
    const cp = Math.cos(this.pitch);
    return v3(cp * Math.cos(this.yaw), Math.sin(this.pitch), cp * Math.sin(this.yaw));
  }

  // map-camera は yaw/pitch/pan を「相対座標の Vec3」として扱い、frame.ts 境界でだけ
  // relative/inertial の brand を付け外しする(両者は同じ数値表現で、変換の実体は frame.ts)。
  // 時刻はキャッシュした simTime、天体暦は注入された ephemeris(共有参照)から取る。
  private toEci(rel: Vec3, frame: Frame): Vec3 {
    return toInertialPos(frame, this.simTime, rel as unknown as RelativeVec3, this.ephemeris);
  }
  private toRel(eci: Vec3, frame: Frame): Vec3 {
    return toFramePos(frame, this.simTime, eci, this.ephemeris) as unknown as Vec3;
  }

  get cameraFrame(): Frame {
    return this._cameraFrame;
  }

  // 座標系を切り替える。保持している相対座標(pan・注視方向)を「一度 ECI へ戻してから
  // 新 Frame へ」入れ直すので、切替の瞬間にカメラ視点(ECI)は跳ばず、以後は新 Frame に固定
  // されて追従する。方位差のぶんだけ yaw が変わる(仰角 pitch は回転軸=Y のまわりなので不変
  // だが、汎用に frame.ts の往復から導出する)。plan-system はこのセッターに代入するだけ。
  set cameraFrame(frame: Frame) {
    const from = this._cameraFrame;
    if (frame === from) return;
    this.pan = this.toRel(this.toEci(this.pan, from), frame);
    const dir = this.toRel(this.toEci(this.offsetDir(), from), frame);
    this.yaw = Math.atan2(dir.z, dir.x);
    this.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    this._cameraFrame = frame;
  }

  // 毎フレーム、マップカメラの位置・向きをマウス/矢印キー操作から更新する。
  // 地球中心の固定座標系カメラなので自機位置は受け取らない。yaw/pitch/pan は cameraFrame
  // 相対で持ち、最後に position/lookTarget を frame.ts 経由で絶対 ECI へ変換する。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    simTime: number,
  ): void {
    this.simTime = simTime;
    const focus = this.resolveFocus();
    // 戦闘ビューは yaw -= dx*0.005 なので、符号を反転させて左右の回転方向を揃える
    this.yaw += mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    this.pitch = Math.max(
      -1.4,
      Math.min(1.4, this.pitch + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt),
    );
    this.dist = Math.max(C.MAP_MIN_DIST, Math.min(C.MAP_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0012)));
    // 注視点 → カメラ方向の単位ベクトル(相対座標。pan を含まない — pan はカメラと注視点を
    // 等しく平行移動させるため基底に影響しない)。
    const off = this.offsetDir();
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      // ピクセル → マップ世界メートル変換。THREE の lookAt(up=+Y) が作る基底と一致する
      // カメラ右/上ベクトルを yaw/pitch から解析的に組む(相対座標のまま累積する — 回転軸=Y の
      // まわりで WORLD_UP は不変なので、ECI への変換は最後の toEci にまとめられる)。
      const viewDir = scale(off, -1);
      const right = norm(cross(viewDir, WORLD_UP));
      const camUp = norm(cross(right, viewDir));
      const metersPerPixel =
        (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))) /
        Math.max(1, window.innerHeight);
      this.pan = addScaled(this.pan, right, -mouse.panDx * metersPerPixel);
      this.pan = addScaled(this.pan, camUp, mouse.panDy * metersPerPixel);
    }
    // 相対座標(pan、カメラ位置)を frame.ts 経由で ECI へ戻し、ECI の focus に足す。
    const camRel = addScaled(this.pan, off, this.dist);
    this.position = add(focus, this.toEci(camRel, this._cameraFrame));
    this.lookTarget = add(focus, this.toEci(this.pan, this._cameraFrame));
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
