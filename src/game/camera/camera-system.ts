import * as THREE from 'three/webgpu';
import { Hud } from '../hud/hud';
import { GunsightCamera } from './gunsight-camera';
import { defaultMapViewInitial, FocusCamera, FOCUS_CAMERA_MIN_DIST } from './focus-camera';
import type { FocusTarget } from './focus-target';
import { Player } from '../player/player';
import { frameRoleAnchorId } from '../../physics/frame';
import { ViewOptionsPanel } from '../hud/panels/view-options-panel';
import { catalogFamilyIndex } from '../celestial/orbit-guide/orbit-guide-catalog';
import { applyMapDisplayMode, MapDisplayToggles, DEFAULT_MAP_DISPLAY_TOGGLES, normalizeMapDisplayToggles } from '../map/display-toggles';
import type { FocusCandidate } from './focus-target';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { FloatingOrigin } from './floating-origin';
import { Vec3, len, sub, v3 } from '../../math/vec3';
import {
  metersPerPixel, metersPerPixelAtDistance, ndcToScreen, Projected, projectToNdc, Viewpoint,
} from '../../math/projection';
import type { FrameAnchorSource } from '../../physics/frame';
import type { Quat } from '../../math/quat';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { View } from '../view/view';
import { CameraSaveData } from '../save/save-data';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

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

// 戦闘ビューの初期視点: 操作対象の後方やや上から見下ろす(役割フォーカス+姿勢追従)。
const COMBAT_CAMERA_FOV = 55; // 通常時の垂直画角 [deg]
const COMBAT_CAMERA_INIT_YAW = -Math.PI / 2;
const COMBAT_CAMERA_INIT_PITCH = 0.3 - (10 * Math.PI) / 180;
const COMBAT_CAMERA_INIT_DIST = 38;

const ZOOM_LERP_RATE = 9; // ガンサイトとの画角遷移の追従速度 [1/s]

// current から target へ、fovDeg だけを指数的に近づけた Viewpoint を返す(position/lookTarget/up/
// aspect はアニメーションせず target の値をそのまま採用する — カメラの向き自体は毎フレーム
// 追従してよく、揺れて見えるのは FOV だけで十分なため)。
function lerpViewpointFov(current: Viewpoint, target: Viewpoint, dt: number): Viewpoint {
  const k = 1 - Math.exp(-ZOOM_LERP_RATE * dt);
  return { ...target, fovDeg: current.fovDeg + (target.fovDeg - current.fovDeg) * k };
}

// 矢印キーでの視点回転 [rad/s]。マウスドラッグと同じ感覚になる値。
const CAM_KEY_YAW_RATE = 1.4;
const CAM_KEY_PITCH_RATE = 1.0;
const CAM_KEY_ROLL_RATE = 1.4; // テンキー0/1での視点ロール [rad/s]
const CAM_KEY_PAN_RATE = 600; // @/:/;/]での視点平行移動、中クリックドラッグと同じ px/s 換算で加算

export type ProjectFn = (worldPos: Vec3) => Projected;
export type ScaleFn = (worldPos: Vec3) => number;

// 論理カメラの状態(Viewpoint)を、描画原点 origin を差し引いて THREE カメラへ反映する。
// near/far はサブカメラ自身の near/far getter(固定値、または FocusCamera のように dist に
// 比例する値)から毎フレーム渡される。
function syncCameraToViewpoint(
  camera: THREE.Camera, view: Viewpoint, near: number, far: number, origin: Vec3,
): void {
  const position = sub(view.position, origin);
  const lookTarget = sub(view.lookTarget, origin);
  camera.position.set(position.x, position.y, position.z);
  camera.up.set(view.up.x, view.up.y, view.up.z);
  camera.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);
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
    const halfHeight = Math.max(FOCUS_CAMERA_MIN_DIST * 1e-6, view.orthographicHalfHeight ?? 1);
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

// 同じ注視カメラ(FocusCamera)の戦闘用・マップ用の2インスタンスを、ビューに応じて切り替えて
// 駆動する。戦闘ビューではガンサイトズーム([Z])と画角遷移をその上に重ねる。
export class CameraSystem {
  readonly combatCamera: FocusCamera;
  readonly mapCamera: FocusCamera;
  private readonly gunsightCamera = new GunsightCamera();
  private _zoomActive = false;
  // 戦闘ビューの表示視点。軌道視点とガンサイトの間で fovDeg だけを指数的に遷移させた後の値。
  private combatViewpoint: Viewpoint = {
    position: v3(),
    up: v3(0, 1, 0),
    lookTarget: v3(),
    fovDeg: COMBAT_CAMERA_FOV,
    aspect: window.innerWidth / window.innerHeight,
  };
  // 表示パネル(天体クラス表示トグル+天球グリッドトグル+軌道ガイドタブ)。天球グリッド・
  // 軌道ガイド側の配線は Navball が行う。
  readonly viewOptionsPanel: ViewOptionsPanel;
  // 現在のビュー。ビューの正本(ViewManager)から毎回読む。
  get view(): View { return this.currentView(); }
  // マップビューのインスタンスがアクティブか。
  private get mapActive(): boolean { return this.currentView() === 'map'; }

  // クラスごとの天体表示トグル。マップのラベル・軌道物体一覧・配置UIの基準天体が
  // この1つの状態を共有する(map/visibility-policy.ts へ渡す)。フォーカスと
  // 太陽系パネルを既に所有しているこのクラスが、同じ場所で持つ。
  private _bodyClassToggles: MapDisplayToggles = loadBodyClassToggles();
  get mapDisplayToggles(): MapDisplayToggles { return this._bodyClassToggles; }

  private readonly viewResetBtn: HTMLElement | null;

  // 視点リセットボタン押下で、現在のビューに応じたカメラをリセットする。
  private readonly handleViewReset = (e: PointerEvent): void => {
    e.stopPropagation();
    this.resetActiveCamera();
  };

  // 現在のビューの視点をリセットする。戦闘は初期状態(操作対象へフォーカス・姿勢追従・
  // 既定の後方見下ろし)へ、マップはロールとパンだけを戻す。
  private resetActiveCamera(): void {
    if (this.mapActive) {
      this.mapCamera.reset();
      return;
    }
    this.combatCamera.resetToInitial();
    this.hud.hint('視点をリセット');
  }

  // 両カメラを構築し、常用ショートリストパネルの選択操作を配線する。
  // saved があれば両カメラをその視点から組む。currentView はビューの正本を引く関数 —
  // ViewManager より先に生成されるため、参照でなく遅延評価で受ける。
  // attitudeOf はフォーカス機体の姿勢追従に使う解決関数(FocusCameraConfig 参照)。
  constructor(
    private readonly hud: Hud,
    celestialSystem: CelestialSystem,
    private readonly currentView: () => View,
    attitudeOf: (id: string, t: number) => Quat | null,
    saved?: Pick<CameraSaveData, 'chase' | 'overview'>,
  ) {
    // ChaseSaveDataV1 形の戦闘視点は読み捨て、既定視点で組む。
    const savedChase = saved?.chase;
    const combatSaved = savedChase !== undefined && !('rot' in savedChase) ? savedChase : undefined;
    this.combatCamera = new FocusCamera(hud, celestialSystem, {
      focusLossPolicy: 'hold',
      initial: {
        yaw: COMBAT_CAMERA_INIT_YAW,
        pitch: COMBAT_CAMERA_INIT_PITCH,
        dist: COMBAT_CAMERA_INIT_DIST,
        fovDeg: COMBAT_CAMERA_FOV,
        focus: { kind: 'object', id: frameRoleAnchorId('activeShip') },
        follow: { kind: 'attitude' },
      },
      attitudeOf,
    }, combatSaved);
    this.mapCamera = new FocusCamera(
      hud, celestialSystem,
      { focusLossPolicy: 'fallToOrigin', initial: defaultMapViewInitial(celestialSystem), attitudeOf },
      saved?.overview,
    );
    // 表示パネルと天体クラス側操作のコールバック
    this.viewOptionsPanel = new ViewOptionsPanel(hud.mapRoot, catalogFamilyIndex());
    this.viewOptionsPanel.onBodyClassModeChange = (key, mode) => {
      this._bodyClassToggles = applyMapDisplayMode(this._bodyClassToggles, key, mode);
      saveBodyClassToggles(this._bodyClassToggles);
      this.viewOptionsPanel.setBodyClassToggles(this._bodyClassToggles);
    };
    this.viewOptionsPanel.setBodyClassToggles(this._bodyClassToggles);

    this.viewResetBtn = hud.root.querySelector('#hud-chase-reset') as HTMLElement | null;
    this.viewResetBtn?.addEventListener('pointerdown', this.handleViewReset);
  }

  // 表示パネルを取り除き、視点リセットボタンへの配線を解く。
  dispose(): void {
    this.viewResetBtn?.removeEventListener('pointerdown', this.handleViewReset);
    this.viewOptionsPanel.dispose();
  }

  // 駆動・描画に使うカメラ実体。ビューの切替で、どちらの実体を通すかだけが変わる。
  private get activeFocusCamera(): FocusCamera {
    return this.mapActive ? this.mapCamera : this.combatCamera;
  }

  get activeCamera(): THREE.Camera {
    return this.activeFocusCamera.camera;
  }

  get activeViewpoint(): Viewpoint {
    return this.mapActive ? this.mapCamera.viewpoint : this.combatViewpoint;
  }

  // アクティブカメラの位置(描画原点になる値)を返す。
  get activeCameraPos(): Vec3 {
    return this.activeViewpoint.position;
  }

  // 現在のビューのカメラが注視しているフォーカス対象。
  get activeFocus(): FocusTarget {
    return this.activeFocusCamera.focus;
  }

  // 戦闘ビューでズーム視点(照準ズーム)が有効かどうか。
  get zoomActive(): boolean {
    return !this.mapActive && this._zoomActive;
  }

  // 入力からカメラの向き・ズームを更新する。ビューに応じてどちらか一方のインスタンスだけを
  // 駆動する。displayTime/frameAnchors は座標系変換に使う — 線・メッシュと同じ表示時刻でないと
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
      this.resetActiveCamera();
      return true;
    });

    // [G]: フォーカスが機体のとき、姿勢追従⇄慣性系をトグルする(両ビュー)。
    if (input.takeKey(K.followAttitudeToggle)) {
      const active = this.activeFocusCamera;
      if (active.toggleAttitudeFollow()) {
        const on = active.rotationFollow?.kind === 'attitude';
        this.hud.hint(`視点の姿勢追従: ${on ? 'ON(機体姿勢に追従)' : 'OFF(慣性系)'}`);
      }
    }

    // キー/マウスによる旋回入力をまとめる
    const keyYawRad = ((input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0))
      * CAM_KEY_YAW_RATE * dt;
    const keyPitchRad = ((input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0))
      * CAM_KEY_PITCH_RATE * dt;
    const keyRollLeft = input.down(K.cameraRollLeft);
    const keyRollRight = input.down(K.cameraRollRight);
    
    // /_ の同時押し（ロール左右の同時入力）でマップカメラのロールをリセット
    if (keyRollLeft && keyRollRight) {
      if (this.mapActive) this.mapCamera.reset();
    }
    const keyRoll = (keyRollLeft ? 1 : 0) + (keyRollRight ? -1 : 0);
    const keyPanX = (input.down(K.cameraPanLeft) ? 1 : 0) + (input.down(K.cameraPanRight) ? -1 : 0);
    const keyPanY = (input.down(K.cameraPanUp) ? 1 : 0) + (input.down(K.cameraPanDown) ? -1 : 0);
    const mouse = { ...input.mouse() };
    mouse.panDx += keyPanX * CAM_KEY_PAN_RATE * dt;
    mouse.panDy += keyPanY * CAM_KEY_PAN_RATE * dt;
    mouse.roll += keyRoll * CAM_KEY_ROLL_RATE * dt;

    if (this.mapActive) {
      this.mapCamera.update(mouse, keyYawRad, keyPitchRad, displayTime, focusCandidates, frameAnchors);
      return;
    }
    this._zoomActive = input.down(K.gunsightZoom);
    // 操作対象艦がいなければ照準先が無いので、ズーム要求は無視して軌道視点のままにする。
    const useGunsight = this._zoomActive && player instanceof Player;
    // ガンサイト中の視点操作は、覗いていない軌道視点へ届かせない(解除時に視点が跳ぶ)。
    const stillMouse = { ...mouse, dx: 0, dy: 0, wheel: 0, panDx: 0, panDy: 0, roll: 0 };
    this.combatCamera.update(
      useGunsight ? stillMouse : mouse,
      useGunsight ? 0 : keyYawRad,
      useGunsight ? 0 : keyPitchRad,
      displayTime, focusCandidates, frameAnchors,
    );
    if (useGunsight) this.gunsightCamera.update(player);
    const target = useGunsight ? this.gunsightCamera.viewpoint : this.combatCamera.viewpoint;
    this.combatViewpoint = lerpViewpointFov(this.combatViewpoint, target, dt);
  }

  // 視点状態をこのフレームの描画原点で補正し、アクティブカメラへ反映する。
  sync(): void {
    const active = this.activeFocusCamera;
    syncCameraToViewpoint(active.camera, this.activeViewpoint, active.near, active.far, this.activeCameraPos);
    // マップビューのときだけ表示設定パネルを出す。
    this.viewOptionsPanel.setVisible(this.mapActive);
  }

  // このフレームの描画原点を組み立てて返す。原点(位置)はアクティブカメラの ECI 位置 —
  // カメラ自身の位置成分をほぼ0にしておかないと、遠方の描画対象が f32 の桁落ちでカメラの
  // 動きに合わせて振動する。速度基準は注視点の速度で、原点とは別 concern。
  getFloatingOrigin(): FloatingOrigin {
    return new FloatingOrigin(this.activeCameraPos, this.activeFocusVelocity);
  }

  // アクティブカメラが注視している点の ECI 速度。カメラの並進はこの点が決めるので、
  // 残像の速度基準はこれを使う — 注視点まわりの旋回・パン・ズームは含めない。
  // 速度を答えられない対象(点マーカー)を注視しているあいだは慣性系静止として扱う。
  private get activeFocusVelocity(): Vec3 {
    return this.activeFocusCamera.focusVelocity ?? v3();
  }

  // アクティブカメラの画面投影関数を返す。
  get activeCameraProjection(): ProjectFn {
    return projectionFromViewpoint(this.activeViewpoint);
  }

  // アクティブカメラの画面尺度関数を返す。
  get activeCameraScale(): ScaleFn {
    return scaleFromViewpoint(this.activeViewpoint);
  }

  // アクティブカメラの画面尺度関数を、視点からの直線距離で測って返す。画面の外や視点の背後に
  // ある物体の見かけの大きさは、これでなければ測れない。
  get activeCameraRadialScale(): ScaleFn {
    return radialScaleFromViewpoint(this.activeViewpoint);
  }

  // 両サブカメラの視点状態をセーブデータへ書き出す。どちらが表示中かは ViewManager の責務。
  serialize(): Pick<CameraSaveData, 'chase' | 'overview'> {
    return { chase: this.combatCamera.serialize(), overview: this.mapCamera.serialize() };
  }
}
