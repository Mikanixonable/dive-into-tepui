// 軌道計画モード(マップモード)のカメラと視点操作: マップ地球中心カメラ・
// 太陽回転系表示・フォーカス対象。「マップモード中の視点」の担当で、mapMode 中のみ
// 意味を持つ。フォーカス対象(文字列 focus)はこのクラス自身が持ち、地球中心 or
// ラベル位置への解決も MapMarkers を注入されて自力で行う(呼び出し側は「どこを見る
// か」を一切知らずに済む)。未来ゴーストスライダー(sliderT)はカメラの視点計算に
// 使われないため PlanDisplay 側の責務 — ここには置かない。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { MouseDelta } from '../input/input';
import { MapMarkers } from './map-markers';
import { FloatingOrigin } from '../floating-origin';

const WORLD_UP = v3(0, 1, 0);

export class MapCamera {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0.7;
  pitch = 0.45;
  dist = 4.5e7;
  // ワールド距離(メートル)のパン変位。カメラと注視点へ等しく加えるので真の平行移動になる。
  pan: Vec3 = v3();
  frameRotating = false;
  // 注視対象のラベル ID('earth' またはラベル ID)。位置解決は resolveFocus が行う。
  focus = 'earth';

  // update() が算出し sync() が camera へ反映する視点の数学状態。ビュー計算・保持は
  // すべて慣性系(physics/vec3、絶対 ECI)で行い、THREE.js への変換は sync() が fo 経由で行う。
  position: Vec3 = v3();
  private lookTarget: Vec3 = v3();
  private aspect = window.innerWidth / window.innerHeight;

  // sfx は現状未使用だが、hud/sfx は必ず対で注入する方針のため受け取る(フィールドとしては保持しない)。
  constructor(
    private readonly _hud: Hud,
    _sfx: Sfx,
    private readonly mapMarkers: MapMarkers,
  ) {
    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      1e4,
      C.MAP_CAMERA_FAR,
    );
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

  // 毎フレーム、マップカメラの位置・向きをマウス/矢印キー操作から更新する。
  // 地球中心の固定座標系カメラなので自機位置は受け取らない。
  // sunAz: 太陽回転系表示の追従角。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    sunAz: number,
  ): void {
    const focus = this.resolveFocus();
    // 戦闘ビューは yaw -= dx*0.005 なので、符号を反転させて左右の回転方向を揃える
    this.yaw += mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    this.pitch = Math.max(
      -1.4,
      Math.min(1.4, this.pitch + mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt),
    );
    this.dist = Math.max(C.MAP_MIN_DIST, Math.min(C.MAP_MAX_DIST, this.dist * Math.exp(mouse.wheel * 0.0012)));
    const cp = Math.cos(this.pitch);
    // 太陽回転系表示: 太陽の実際の方位ドリフトぶんカメラ方位を追従させ、
    // 画面上で太陽方向がほぼ固定されて見えるようにする(予測サンプルの回転補正と
    // 組み合わせて、t=simTime では回転量ゼロで整合する)。
    const displayYaw = this.yaw + (this.frameRotating ? sunAz : 0);
    // ターゲット → カメラ方向の単位ベクトル(pan を含まない — pan はカメラと注視点を
    // 等しく平行移動させるため基底に影響しない)。
    const off = v3(cp * Math.cos(displayYaw), Math.sin(this.pitch), cp * Math.sin(displayYaw));
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      // ピクセル → マップ世界メートル変換。THREE の lookAt(up=+Y) が作る基底と一致する
      // カメラ右/上ベクトルを yaw/pitch から解析的に組み、軌道 yaw/pitch に依存させない。
      const viewDir = scale(off, -1);
      const right = norm(cross(viewDir, WORLD_UP));
      const camUp = norm(cross(right, viewDir));
      const metersPerPixel =
        (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5))) /
        Math.max(1, window.innerHeight);
      this.pan = addScaled(this.pan, right, -mouse.panDx * metersPerPixel);
      this.pan = addScaled(this.pan, camUp, mouse.panDy * metersPerPixel);
    }
    const target = add(focus, this.pan);
    this.position = addScaled(target, off, this.dist);
    this.lookTarget = target;
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
