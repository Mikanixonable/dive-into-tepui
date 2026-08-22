import * as THREE from 'three/webgpu';
import { Hud } from '../hud/hud';
import { CombatCameraSystem } from './combat-camera-system';
import { MapCamera } from './map-camera';
import { ViewOptionsPanel } from '../hud/view-options-panel';
import { FocusMarkers } from './focus-markers';
import { BodyClassToggles, DEFAULT_BODY_CLASS_TOGGLES } from '../celestial/body-visibility';
import { MapPickable } from '../map-pickable';
import { MarkerManager } from '../marker/marker-manager';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { Vec3 } from '../../physics/vec3';
import { metersPerPixel, ndcToScreen, Projected, projectToNdc, Viewpoint } from '../../physics/projection';
import { CelestialBody } from '../../physics/celestial-body';
import type { Ephemeris } from '../../physics/ephemeris';
import { CameraSaveData } from '../save-data';

const BODY_CLASS_TOGGLES_STORAGE_KEY = 'tepui.bodyClassToggles';

// localStorage から天体クラス別トグルを読み込む。取得できなければ既定値を返す。
function loadBodyClassToggles(): BodyClassToggles {
  try {
    const raw = localStorage.getItem(BODY_CLASS_TOGGLES_STORAGE_KEY);
    if (!raw) return DEFAULT_BODY_CLASS_TOGGLES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_BODY_CLASS_TOGGLES;
    return { ...DEFAULT_BODY_CLASS_TOGGLES, ...parsed };
  } catch {
    return DEFAULT_BODY_CLASS_TOGGLES;
  }
}

// 天体クラス別トグルを localStorage へ保存する。
function saveBodyClassToggles(v: BodyClassToggles): void {
  try {
    localStorage.setItem(BODY_CLASS_TOGGLES_STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage 不可なら保存しない(次回リロード時は既定値に戻る) */
  }
}

import type { GameEntity } from '../game-entity/game-entity';

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
    const halfHeight = Math.max(C.OVERVIEW_CAMERA_MIN_DIST * 1e-6, view.orthographicHalfHeight ?? 1);
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

// 戦闘ビュー(CombatCameraSystem)と広範囲視点(MapCamera)を切り替えて駆動する。
// フォーカス候補ラベル(focusMarkers)も所有する。
export class CameraSystem {
  readonly combatCamera: CombatCameraSystem;
  readonly mapCamera: MapCamera;
  readonly focusMarkers: FocusMarkers;
  // 表示パネル(天体クラス表示トグル+天球グリッドトグル)。天球グリッド側の配線は Navball が行う。
  readonly viewOptionsPanel: ViewOptionsPanel;
  // 広範囲視点に切り替わっているか(視点・描画側の判定に使う)。
  private _overviewMode = false;
  get overviewMode(): boolean { return this._overviewMode; }

  // クラスごとの天体表示トグル。マップのラベル・軌道物体一覧・配置UIの基準天体が
  // この1つの状態を共有する(body-visibility.ts の visibleBodyIds に渡す)。フォーカスと
  // 太陽系パネルを既に所有しているこのクラスが、同じ場所で持つ。
  private _bodyClassToggles: BodyClassToggles = loadBodyClassToggles();
  get bodyClassToggles(): BodyClassToggles { return this._bodyClassToggles; }

  setMapMode(open: boolean): void { this._overviewMode = open; }

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

  // 両カメラとフォーカス候補ラベルを構築し、常用ショートリストパネルの選択操作を配線する。
  // saved があれば両カメラをその視点から組む。
  constructor(
    _hud: Hud,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
    saved?: Pick<CameraSaveData, 'chase' | 'overview'>,
  ) {
    // 両カメラとフォーカス候補ラベル
    this.focusMarkers = new FocusMarkers(markerManager, ephemeris);
    this.combatCamera = new CombatCameraSystem(_hud, saved?.chase);
    this.mapCamera = new MapCamera(_hud, ephemeris, saved?.overview);
    // 表示パネルと天体クラス側操作のコールバック
    this.viewOptionsPanel = new ViewOptionsPanel(_hud.mapRoot);
    this.viewOptionsPanel.onBodyClassToggle = (key, on) => {
      this._bodyClassToggles = { ...this._bodyClassToggles, [key]: on };
      saveBodyClassToggles(this._bodyClassToggles);
    };

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
  // displayTime/celestialBodies は広範囲視点の座標系変換にのみ使う — 線・メッシュと同じ表示時刻でないと
  // 回転系選択時にカメラだけが現在時刻に取り残される。
  update(
    player: GameEntity | null,
    displayTime: number,
    input: Input,
    dt: number,
    mapPickables: readonly MapPickable[],
    celestialBodies: readonly CelestialBody[],
  ): void {
    // 中クリックで視点リセット
    input.takeMiddleClicks(() => {
      if (this.overviewMode) this.mapCamera.reset();
      else this.combatCamera.reset();
      return true;
    });


    // キー/マウスによる旋回入力をまとめる
    const keyYaw = (input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0);
    const keyPitch = (input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0);
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
    mouse.panDx += keyPanX * C.CAM_KEY_PAN_RATE * dt;
    mouse.panDy += keyPanY * C.CAM_KEY_PAN_RATE * dt;
    mouse.roll += keyRoll * C.CAM_KEY_ROLL_RATE * dt;

    if (this.overviewMode) {
      this.mapCamera.update(mouse, keyYaw, keyPitch, dt, displayTime, mapPickables, celestialBodies);
    }
    else {
      this.combatCamera.update(mouse, keyYaw, keyPitch, dt, player, input);
    }
  }

  // 視点状態をフローティングオリジン(fo)で補正してアクティブカメラへ反映する。
  sync(fo: FloatingOrigin): void {
    const active = this.overviewMode ? this.mapCamera : this.combatCamera;
    syncCameraToViewpoint(active.camera, active.viewpoint, active.near, active.far, fo);
    // 広範囲視点のときだけ操作パネルとフォーカスラベルを表示する
    this.viewOptionsPanel.setVisible(this.overviewMode);
    this.viewOptionsPanel.setBodyClassToggles(this._bodyClassToggles);

    if (this.overviewMode) {
      this.focusMarkers.syncLabels(this.activeCameraProjection, this.activeCameraPos);
    } else {
      this.focusMarkers.hideLabels();
    }
  }

  // アクティブカメラの画面投影関数を返す。
  get activeCameraProjection(): ProjectFn {
    return projectionFromViewpoint(this.overviewMode ? this.mapCamera.viewpoint : this.combatCamera.viewpoint);
  }

  // アクティブカメラの画面尺度関数を返す。
  get activeCameraScale(): ScaleFn {
    return scaleFromViewpoint(this.overviewMode ? this.mapCamera.viewpoint : this.combatCamera.viewpoint);
  }

  // 両サブカメラの視点状態をセーブデータへ書き出す。どちらが表示中かは ViewManager の責務。
  serialize(): Pick<CameraSaveData, 'chase' | 'overview'> {
    return { chase: this.combatCamera.serialize(), overview: this.mapCamera.serialize() };
  }
}
