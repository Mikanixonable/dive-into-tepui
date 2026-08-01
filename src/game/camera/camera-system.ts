import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { CombatCameraSystem } from './combat-camera-system';
import { OverviewCamera } from './overview-camera';
import { OverviewCameraPanel } from './overview-camera-panel';
import { FocusMarkers } from './focus-markers';
import { FocusGizmo } from './focus-gizmo';
import { MarkerManager } from '../marker/marker-manager';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';
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
// など)へはラベル右クリックのメニュー(FocusGizmo)からフォーカスする。
const PANEL_FOCUS_IDS = ['earth', 'moon', 'sun'] as const;

// 戦闘ビュー(CombatCameraSystem)と広範囲視点(OverviewCamera)を切り替えて駆動する。
// フォーカス候補(focusMarkers)とその選択 UI(focusGizmo / overviewCameraPanel)も所有する。
export class CameraSystem {
  readonly combatCamera: CombatCameraSystem;
  readonly overviewCamera: OverviewCamera;
  readonly focusMarkers: FocusMarkers;
  private readonly focusGizmo = new FocusGizmo();
  // 広範囲視点の操作パネル(注視対象・視点の座標系・視点リセット)。
  private readonly overviewCameraPanel: OverviewCameraPanel;
  // 広範囲視点に切り替わっているか(視点・描画側の判定に使う)。
  overviewMode = false;

  // 両カメラとフォーカス候補ラベル、フォーカス選択 UI を構築し、パネルの選択操作を配線する。
  constructor(
    private readonly _hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
  ) {
    // 両カメラとフォーカス候補ラベル
    this.focusMarkers = new FocusMarkers(markerManager, ephemeris);
    this.combatCamera = new CombatCameraSystem(_hud, sfx);
    this.overviewCamera = new OverviewCamera(_hud, sfx, this.focusMarkers, ephemeris);
    // ラベル右クリックメニューでのフォーカス選択
    this.focusGizmo.onMenuFocus = (targetKey) => {
      this.overviewCamera.focus = targetKey;
      const lbl = this.focusMarkers.findLabel(targetKey);
      if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
    };
    // 広範囲視点の操作パネルと各操作のコールバック
    this.overviewCameraPanel = new OverviewCameraPanel(_hud.root, PANEL_FOCUS_IDS.map(
      (id) => [id, this.focusMarkers.findLabel(id)?.name ?? id] as const,
    ));
    this.overviewCameraPanel.onFocusSelect = (focus) => {
      this.overviewCamera.focus = focus;
      this.overviewCamera.resetPan();
    };
    this.overviewCameraPanel.onViewReset = () => this.overviewCamera.reset();
    this.overviewCameraPanel.onFrameSelect = (frame: Frame) => {
      this.overviewCamera.cameraFrame = frame;
    };
  }

  // マップ編集中のポインタ操作。最寄りラベルがあればフォーカス選択メニューを開いて消費する。
  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleFocusRightClick(p.x, p.y));
  }

  // 最寄りラベル(FOCUS_LABEL_PICK_PX 以内)があればフォーカス選択メニューを開いて true を返す。
  private handleFocusRightClick(clientX: number, clientY: number): boolean {
    // 全ラベルとの画面距離を比較し最も近いものを選ぶ
    const project = this.activeCameraProjection;
    let bestKey: string | null = null;
    let bestD = C.FOCUS_LABEL_PICK_PX * C.FOCUS_LABEL_PICK_PX;
    for (const lbl of this.focusMarkers.labels) {
      const p = project(lbl.pos);
      if (!p.front) continue;
      const d = (p.x - clientX) * (p.x - clientX) + (p.y - clientY) * (p.y - clientY);
      if (d < bestD) {
        bestD = d;
        bestKey = lbl.id;
      }
    }
    // 見つかればメニューを開く
    if (bestKey === null) return false;
    this.focusGizmo.openMenu(clientX, clientY, bestKey);
    return true;
  }

  // フォーカス選択メニューを閉じる。
  closeFocusMenu(): void {
    this.focusGizmo.closeMenu();
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
    player: Player,
    simTime: number,
    input: Input,
    dt: number,
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
    const mouse = input.mouse();

    if (this.overviewMode) {
      this.overviewCamera.update(mouse, keyYaw, keyPitch, dt, simTime);
    }
    else {
      this.combatCamera.update(mouse, keyYaw, keyPitch, dt, player, input);
    }
  }

  // 視点状態をフローティングオリジン(fo)で補正してアクティブカメラへ反映する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    const active = this.overviewMode ? this.overviewCamera : this.combatCamera;
    syncCameraToViewFrame(active.camera, active.view, fo);
    // 広範囲視点のときだけ操作パネルとフォーカスラベルを表示する
    this.overviewCameraPanel.setVisible(this.overviewMode);
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