import * as THREE from 'three/webgpu';
import { Hud } from '../hud/hud';
import { CombatCameraSystem } from './combat-camera-system';
import { MapCamera, OVERVIEW_CAMERA_MIN_DIST } from './map-camera';
import { ViewOptionsPanel } from '../hud/panels/view-options-panel';
import { catalogFamilyIndex } from '../celestial/orbit-guide/orbit-guide-catalog';
import { applyMapDisplayMode, MapDisplayToggles, DEFAULT_MAP_DISPLAY_TOGGLES, normalizeMapDisplayToggles } from '../map/display-toggles';
import type { FocusCandidate } from './focus-target';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { FloatingOrigin } from './floating-origin';
import { Vec3, len, sub } from '../../math/vec3';
import {
  metersPerPixel, metersPerPixelAtDistance, ndcToScreen, Projected, projectToNdc, Viewpoint,
} from '../../math/projection';
import type { FrameAnchorSource } from '../../physics/frame';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { WorldView } from '../view-manager';
import { CameraSaveData } from '../save/save-data';

const BODY_CLASS_TOGGLES_STORAGE_KEY = 'tepui.mapDisplayToggles';

// localStorage から天体クラス別トグルを読み込む。取得できなければ既定値を返す。
function loadBodyClassToggles(): MapDisplayToggles {
  try {
    const raw = localStorage.getItem(BODY_CLASS_TOGGLES_STORAGE_KEY);
    if (!raw) return DEFAULT_MAP_DISPLAY_TOGGLES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_MAP_DISPLAY_TOGGLES;
    return normalizeMapDisplayToggles({ ...DEFAULT_MAP_DISPLAY_TOGGLES, ...parsed });
  } catch {
    return DEFAULT_MAP_DISPLAY_TOGGLES;
  }
}

// 天体クラス別トグルを localStorage へ保存する。
function saveBodyClassToggles(v: MapDisplayToggles): void {
  try {
    localStorage.setItem(BODY_CLASS_TOGGLES_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage 不可なら保存しない(次回リロード時は既定値に戻る) */
  }
}

import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

// 矢印キーでの視点回転 [rad/s]。マウスドラッグと同じ感覚になる値。
const CAM_KEY_YAW_RATE = 1.4;
const CAM_KEY_PITCH_RATE = 1.0;
const CAM_KEY_ROLL_RATE = 1.4; // テンキー0/1での視点ロール [rad/s]
const CAM_KEY_PAN_RATE = 600; // @/:/;/]での視点平行移動、中クリックドラッグと同じ px/s 換算で加算

export type ProjectFn = (worldPos: Vec3) => Projected;
export type ScaleFn = (worldPos: Vec3) => number;

// 論理カメラの状態(Viewpoint)を THREE カメラへ反映する。near/far はサブカメラ自身の
// near/far getter(固定値、または MapCamera のように dist に比例する値)から毎フレーム渡される。
function syncCameraToViewpoint(camera: THREE.Camera, view: Viewpoint, near: number, far: number, fo: FloatingOrigin): void {
  camera.position.copy(fo.RtoThreeV3(view.position));
  camera.up.set(view.up.x, view.up.y, view.up.z);
  camera.lookAt(fo.RtoThreeV3(view.lookTarget));
  // アスペクト比・FOV・near・far が変わったときだけ投影行列を再計算する
  let projectionDirty = false;
  if (camera instanceof THREE.PerspectiveCamera) {
    if (Math.abs(camera.aspect - view.aspect) > 1e-6) {
      camera.aspect = view.aspect;
      projectionDirty = true;
    }
    if (Math.abs(camera.fov - view.fovDeg) > 1e-3) {
      camera.fov = view.fovDeg;
      projectionDirty = true;
    }
    if (Math.abs(camera.near - near) > near * 1e-6) {
      camera.near = near;
      projectionDirty = true;
    }
    if (Math.abs(camera.far - far) > far * 1e-6) {
      camera.far = far;
      projectionDirty = true;
    }
  } else if (camera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(OVERVIEW_CAMERA_MIN_DIST * 1e-6, view.orthographicHalfHeight ?? 1);
    const halfWidth = halfHeight * view.aspect;
    if (Math.abs(camera.left + halfWidth) > halfWidth * 1e-6
      || Math.abs(camera.right - halfWidth) > halfWidth * 1e-6
      || Math.abs(camera.top - halfHeight) > halfHeight * 1e-6
      || Math.abs(camera.bottom + halfHeight) > halfHeight * 1e-6) {
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight;
      camera.bottom = -halfHeight;
      projectionDirty = true;
    }
    if (Math.abs(camera.near - near) > near * 1e-6) {
      camera.near = near;
      projectionDirty = true;
    }
    if (Math.abs(camera.far - far) > far * 1e-6) {
      camera.far = far;
      projectionDirty = true;
    }
  }
  if (projectionDirty && (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) {
    camera.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
}

// THREE.js カメラ行列やフローティングオリジンに依存しないスクリーン投影関数を組む。
function projectionFromViewpoint(view: Viewpoint): ProjectFn {
  return (worldPos) => ndcToScreen(projectToNdc(view, worldPos), window.innerWidth, window.innerHeight);
}

// 画面上で1ピクセルに相当する実距離[m]を返す関数を組む。
function scaleFromViewpoint(view: Viewpoint): ScaleFn {
  return (worldPos) => metersPerPixel(view, worldPos, window.innerHeight);
}

// 同じ尺度を、視点からの直線距離で測って返す関数を組む。**画面に写らない位置にある物体の
// 見かけの大きさを測るのはこちら** — 深度で測る側は視点の背後で床打ちされ、遠く後方にある
// 物体が目の前にあるのと同じ尺度を返す。
function radialScaleFromViewpoint(view: Viewpoint): ScaleFn {
  return (worldPos) => metersPerPixelAtDistance(view, len(sub(worldPos, view.position)), window.innerHeight);
}

// 戦闘ビュー(CombatCameraSystem)と広範囲視点(MapCamera)を切り替えて駆動する。
export class CameraSystem {
  readonly combatCamera: CombatCameraSystem;
  readonly mapCamera: MapCamera;
  // 表示パネル(天体クラス表示トグル+天球グリッドトグル+軌道ガイドタブ)。天球グリッド・
  // 軌道ガイド側の配線は Navball が行う。
  readonly viewOptionsPanel: ViewOptionsPanel;
  // 広範囲視点に切り替わっているか。ビューの正本(ViewManager)から毎回読む。
  get overviewMode(): boolean { return this.view() === 'map'; }

  // クラスごとの天体表示トグル。マップのラベル・軌道物体一覧・配置UIの基準天体が
  // この1つの状態を共有する(map/visibility-policy.ts へ渡す)。フォーカスと
  // 太陽系パネルを既に所有しているこのクラスが、同じ場所で持つ。
  private _bodyClassToggles: MapDisplayToggles = loadBodyClassToggles();
  get mapDisplayToggles(): MapDisplayToggles { return this._bodyClassToggles; }

  private readonly chaseResetBtn: HTMLElement | null;

  // 追従リセットボタン押下で、現在のビューに応じたカメラをリセットする。
  private readonly handleChaseReset = (e: PointerEvent): void => {
    e.stopPropagation();
    if (this.overviewMode) {
      this.mapCamera.reset();
    } else {
      this.combatCamera.reset();
    }
  };

  // 両カメラを構築し、常用ショートリストパネルの選択操作を配線する。
  // saved があれば両カメラをその視点から組む。view はビューの正本を引く関数 —
  // ViewManager より先に生成されるため、参照でなく遅延評価で受ける。
  constructor(
    _hud: Hud,
    celestialSystem: CelestialSystem,
    private readonly view: () => WorldView,
    saved?: Pick<CameraSaveData, 'chase' | 'overview'>,
  ) {
    this.combatCamera = new CombatCameraSystem(_hud, saved?.chase);
    this.mapCamera = new MapCamera(_hud, celestialSystem, saved?.overview);
    // 表示パネルと天体クラス側操作のコールバック
    this.viewOptionsPanel = new ViewOptionsPanel(_hud.mapRoot, catalogFamilyIndex());
    this.viewOptionsPanel.onBodyClassModeChange = (key, mode) => {
      this._bodyClassToggles = applyMapDisplayMode(this._bodyClassToggles, key, mode);
      saveBodyClassToggles(this._bodyClassToggles);
      this.viewOptionsPanel.setBodyClassToggles(this._bodyClassToggles);
    };
    this.viewOptionsPanel.setBodyClassToggles(this._bodyClassToggles);

    this.chaseResetBtn = _hud.root.querySelector('#hud-chase-reset') as HTMLElement | null;
    this.chaseResetBtn?.addEventListener('pointerdown', this.handleChaseReset);
  }

  // 表示パネルを取り除き、追従リセットボタンへの配線を解く。
  dispose(): void {
    this.chaseResetBtn?.removeEventListener('pointerdown', this.handleChaseReset);
    this.viewOptionsPanel.dispose();
  }

  // 現在アクティブなカメラ(広範囲視点/戦闘追従視点)を返す。
  get activeCamera(): THREE.Camera {
    return this.overviewMode ? this.mapCamera.camera : this.combatCamera.camera;
  }

  get activeViewpoint(): Viewpoint {
    return this.overviewMode ? this.mapCamera.viewpoint : this.combatCamera.viewpoint;
  }

  // アクティブカメラの位置(描画原点になる値)を返す。戦闘ビューにいることは操作対象艦がいることを
  // 意味する(ViewManager が canEnter で保証する)ので、この値は実在した艦から計算されたものになる。
  get activeCameraPos(): Vec3 {
    return this.overviewMode ? this.mapCamera.viewpoint.position : this.combatCamera.viewpoint.position;
  }

  // 戦闘ビューでズーム視点(照準ズーム)が有効かどうか。広範囲視点では常に false。
  get zoomActive(): boolean {
    return !this.overviewMode && this.combatCamera.zoomActive;
  }

  // 入力からカメラの向き・ズームを更新する。overviewMode に応じてどちらか一方のカメラだけを駆動する。
  // displayTime/frameAnchors は広範囲視点の座標系変換にのみ使う — 線・メッシュと同じ表示時刻でないと
  // 回転系選択時にカメラだけが現在時刻に取り残される。
  update(
    player: DynamicEntity | null,
    displayTime: number,
    input: Input,
    dt: number,
    focusCandidates: readonly FocusCandidate[],
    frameAnchors: FrameAnchorSource,
  ): void {
    // 中クリックで視点リセット
    input.takeMiddleClicks(() => {
      if (this.overviewMode) this.mapCamera.reset();
      else this.combatCamera.reset();
      return true;
    });


    // キー/マウスによる旋回入力をまとめる
    const keyYawRad = ((input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0))
      * CAM_KEY_YAW_RATE * dt;
    const keyPitchRad = ((input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0))
      * CAM_KEY_PITCH_RATE * dt;
    const keyRollLeft = input.down(K.cameraRollLeft);
    const keyRollRight = input.down(K.cameraRollRight);
    
    // /_ の同時押し（ロール左右の同時入力）でマップカメラのロールをリセット
    if (keyRollLeft && keyRollRight) {
      if (this.overviewMode) this.mapCamera.reset();
    }
    const keyRoll = (keyRollLeft ? 1 : 0) + (keyRollRight ? -1 : 0);
    const keyPanX = (input.down(K.cameraPanLeft) ? 1 : 0) + (input.down(K.cameraPanRight) ? -1 : 0);
    const keyPanY = (input.down(K.cameraPanUp) ? 1 : 0) + (input.down(K.cameraPanDown) ? -1 : 0);
    const mouse = { ...input.mouse() };
    mouse.panDx += keyPanX * CAM_KEY_PAN_RATE * dt;
    mouse.panDy += keyPanY * CAM_KEY_PAN_RATE * dt;
    mouse.roll += keyRoll * CAM_KEY_ROLL_RATE * dt;

    if (this.overviewMode) {
      this.mapCamera.update(mouse, keyYawRad, keyPitchRad, displayTime, focusCandidates, frameAnchors);
    }
    else {
      this.combatCamera.update(mouse, keyYawRad, keyPitchRad, dt, player, input);
    }
  }

  // このフレームの描画原点を組み立て、視点状態をそれで補正してアクティブカメラへ反映し、
  // 組み立てた原点を返す。原点(位置)はアクティブカメラの ECI 位置 — カメラ自身の位置成分を
  // ほぼ0にしておかないと、遠方の描画対象が f32 の桁落ちでカメラの動きに合わせて振動する。
  // 速度基準 velocityReference は相対速度で向きを決める描画が差し引く値で、原点とは別 concern。
  sync(velocityReference: Vec3): FloatingOrigin {
    const fo = new FloatingOrigin(this.activeCameraPos, velocityReference);
    const active = this.overviewMode ? this.mapCamera : this.combatCamera;
    syncCameraToViewpoint(active.camera, active.viewpoint, active.near, active.far, fo);
    // 広範囲視点のときだけ表示設定パネルを出す。
    this.viewOptionsPanel.setVisible(this.overviewMode);
    return fo;
  }

  // アクティブカメラの画面投影関数を返す。
  get activeCameraProjection(): ProjectFn {
    return projectionFromViewpoint(this.overviewMode ? this.mapCamera.viewpoint : this.combatCamera.viewpoint);
  }

  // アクティブカメラの画面尺度関数を返す。
  get activeCameraScale(): ScaleFn {
    return scaleFromViewpoint(this.overviewMode ? this.mapCamera.viewpoint : this.combatCamera.viewpoint);
  }

  // アクティブカメラの画面尺度関数を、視点からの直線距離で測って返す。画面の外や視点の背後に
  // ある物体の見かけの大きさは、これでなければ測れない。
  get activeCameraRadialScale(): ScaleFn {
    return radialScaleFromViewpoint(this.overviewMode ? this.mapCamera.viewpoint : this.combatCamera.viewpoint);
  }

  // 両サブカメラの視点状態をセーブデータへ書き出す。どちらが表示中かは ViewManager の責務。
  serialize(): Pick<CameraSaveData, 'chase' | 'overview'> {
    return { chase: this.combatCamera.serialize(), overview: this.mapCamera.serialize() };
  }
}
