import * as THREE from 'three/webgpu';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { CombatCameraSystem } from './combat-camera-system';
import { OverviewCamera } from './overview-camera';
import { OverviewCameraPanel } from './overview-camera-panel';
import { FocusMarkers } from './focus-markers';
import { MapPickable } from '../map-pick';
import { MarkerManager } from '../marker/marker-manager';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { Vec3 } from '../../physics/vec3';
import { ndcToScreen, Projected, projectToNdc, ViewFrame } from '../../physics/projection';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';

export type ProjectFn = (worldPos: Vec3) => Projected;

// 論理カメラの状態(ViewFrame)を THREE.PerspectiveCamera へ反映する。
function syncCameraToViewFrame(camera: THREE.PerspectiveCamera, view: ViewFrame, fo: FloatingOrigin): void {
  camera.position.copy(fo.RtoThreeV3(view.position));
  camera.up.set(view.up.x, view.up.y, view.up.z);
  camera.lookAt(fo.RtoThreeV3(view.lookTarget));
  // アスペクト比・FOV が変わったときだけ投影行列を再計算する
  let projectionDirty = false;
  if (Math.abs(camera.aspect - view.aspect) > 1e-6) {
    camera.aspect = view.aspect;
    projectionDirty = true;
  }
  if (Math.abs(camera.fov - view.fovDeg) > 1e-3) {
    camera.fov = view.fovDeg;
    projectionDirty = true;
  }
  if (projectionDirty) camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

// THREE.js カメラ行列やフローティングオリジンに依存しないスクリーン投影関数を組む。
function projectionFromView(view: ViewFrame): ProjectFn {
  return (worldPos) => ndcToScreen(projectToNdc(view, worldPos), window.innerWidth, window.innerHeight);
}

// 広範囲視点の操作パネルに常用のフォーカス先として並べるラベル ID。残りのラベル(ラグランジュ点
// など)へは右クリックのメニュー経由でフォーカスする(Game が仲介する)。
const PANEL_FOCUS_IDS = ['earth', 'moon', 'sun'] as const;

// 戦闘ビュー(CombatCameraSystem)と広範囲視点(OverviewCamera)を切り替えて駆動する。
// フォーカス候補ラベル(focusMarkers)とその常用ショートリスト(overviewCameraPanel)も所有する。
export class CameraSystem {
  readonly combatCamera: CombatCameraSystem;
  readonly overviewCamera: OverviewCamera;
  readonly focusMarkers: FocusMarkers;
  // 広範囲視点の操作パネル(注視対象・視点の座標系・視点リセット)。
  private readonly overviewCameraPanel: OverviewCameraPanel;
  // 広範囲視点に切り替わっているか(視点・描画側の判定に使う)。
  private _overviewMode = false;
  get overviewMode(): boolean { return this._overviewMode; }

  get showMapAmmo(): boolean { return this.overviewCameraPanel.showAmmo; }
  setMapMode(open: boolean): void { this._overviewMode = open; }

  // sync() で毎フレーム参照する DOM 要素をコンストラクタ時にキャッシュする。
  private readonly _elStatus: HTMLElement | null;
  private readonly _elStageStatus: HTMLElement | null;
  private readonly _elOrbit: HTMLElement | null;
  // Creativeではマップ視点でも配置済み艦のステータスを表示する。
  private readonly showStatusInOverview: boolean;

  // 両カメラとフォーカス候補ラベルを構築し、常用ショートリストパネルの選択操作を配線する。
  constructor(
    _hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
    player: Player | null,
    showStatusInOverview = false,
  ) {
    this.showStatusInOverview = showStatusInOverview;
    // 両カメラとフォーカス候補ラベル
    this.focusMarkers = new FocusMarkers(markerManager, ephemeris);
    this.combatCamera = new CombatCameraSystem(_hud, sfx, player);
    this.overviewCamera = new OverviewCamera(_hud, sfx, ephemeris);
    // 広範囲視点の操作パネルと各操作のコールバック
    this.overviewCameraPanel = new OverviewCameraPanel(_hud.root, PANEL_FOCUS_IDS.map(
      (id) => [id, this.focusMarkers.findLabel(id)?.name ?? id] as const,
    ));
    this.overviewCameraPanel.onFocusSelect = (focus) => {
      this.overviewCamera.setFocus(focus);
    };
    this.overviewCameraPanel.onFrameSelect = (frame: Frame) => {
      this.overviewCamera.cameraFrame = frame;
    };

    const chaseResetBtn = _hud.root.querySelector('#hud-chase-reset') as HTMLElement | null;
    if (chaseResetBtn) {
      chaseResetBtn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (this.overviewMode) {
          this.overviewCamera.reset();
        } else {
          this.combatCamera.reset();
        }
      });
    }

    // sync() 用の DOM 要素を事前にキャッシュ
    this._elStatus = document.getElementById('hud-status');
    this._elStageStatus = document.getElementById('hud-stagestatus');
    this._elOrbit = document.getElementById('hud-orbit');
  }

  // アクティブ艦の切替を戦闘ビューの追従カメラへ伝える。
  setActivePlayer(player: Player | null): void {
    this.combatCamera.setActivePlayer(player);
  }

  // 現在アクティブなカメラ(広範囲視点/戦闘追従視点)を返す。
  get activeCamera(): THREE.PerspectiveCamera {
    return this.overviewMode ? this.overviewCamera.camera : this.combatCamera.camera;
  }

  // アクティブカメラの位置を返す。
  get activeCameraPos(): Vec3 {
    return this.overviewMode ? this.overviewCamera.view.position : this.combatCamera.view.position;
  }

  // 戦闘ビューでズーム視点(照準ズーム)が有効かどうか。広範囲視点では常に false。
  get zoomActive(): boolean {
    return !this.overviewMode && this.combatCamera.zoomActive;
  }

  // 入力からカメラの向き・ズームを更新する。overviewMode に応じてどちらか一方のカメラだけを駆動する。
  update(
    player: Player | null,
    simTime: number,
    input: Input,
    dt: number,
    mapPickables: readonly MapPickable[],
  ): void {
    // 追従視点トグル
    if (input.takeKey(K.followAttitudeToggle)) this.combatCamera.toggleFollowAttitude();

    // 中クリックで視点リセット
    input.takeMiddleClicks(() => {
      if (this.overviewMode) this.overviewCamera.reset();
      else this.combatCamera.reset();
      return true;
    });


    // キー/マウスによる旋回入力をまとめる
    const keyYaw = (input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0);
    const keyPitch = (input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0);
    const keyRoll = (input.down(K.cameraRollLeft) ? 1 : 0) + (input.down(K.cameraRollRight) ? -1 : 0);
    const keyPanX = (input.down(K.cameraPanLeft) ? 1 : 0) + (input.down(K.cameraPanRight) ? -1 : 0);
    const keyPanY = (input.down(K.cameraPanUp) ? 1 : 0) + (input.down(K.cameraPanDown) ? -1 : 0);
    const mouse = { ...input.mouse() };
    mouse.panDx += keyPanX * C.CAM_KEY_PAN_RATE * dt;
    mouse.panDy += keyPanY * C.CAM_KEY_PAN_RATE * dt;

    if (this.overviewMode) {
      this.overviewCamera.update(mouse, keyYaw, keyPitch, keyRoll, dt, simTime, mapPickables);
    }
    else {
      this.combatCamera.update(mouse, keyYaw, keyPitch, keyRoll, dt, player, input);
    }
  }

  // 視点状態をフローティングオリジン(fo)で補正してアクティブカメラへ反映する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    const active = this.overviewMode ? this.overviewCamera : this.combatCamera;
    syncCameraToViewFrame(active.camera, active.view, fo);
    // 広範囲視点のときだけ操作パネルとフォーカスラベルを表示する
    this.overviewCameraPanel.setVisible(this.overviewMode);

    // 戦闘ビュー固有パネルを広範囲視点では非表示にする
    const hidden = this.overviewMode && !this.showStatusInOverview ? 'none' : '';
    if (this._elStatus) this._elStatus.style.display = hidden;
    if (this._elStageStatus) this._elStageStatus.style.display = hidden;
    if (this._elOrbit) this._elOrbit.style.left = this.overviewMode ? '12px' : '';
    if (this.overviewMode) {
      this.overviewCameraPanel.setFocus(this.overviewCamera.focus);
      this.overviewCameraPanel.setFrame(this.overviewCamera.cameraFrame);
      this.focusMarkers.syncLabels(displayTime, this.activeCameraProjection);
    } else {
      this.focusMarkers.hideLabels();
    }
  }

  // アクティブカメラの画面投影関数を返す。
  get activeCameraProjection(): ProjectFn {
    return projectionFromView(this.overviewMode ? this.overviewCamera.view : this.combatCamera.view);
  }
}
