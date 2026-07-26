import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ChaseCamera } from './chase-camera';
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
import { Projected } from '../../physics/projection';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';

export type ProjectFn = (worldPos: Vec3) => Projected;

// 広範囲視点の操作パネルに常用のフォーカス先として並べるラベル ID。残りのラベル(ラグランジュ点
// など)へはラベル右クリックのメニュー(FocusGizmo)からフォーカスする。
const PANEL_FOCUS_IDS = ['earth', 'moon', 'sun'] as const;

// 戦闘ビュー(ChaseCamera)と広範囲視点(OverviewCamera)を切り替えて駆動する。
// どちらも視点操作のみの責務のカメラで、このクラスが対称に内部保持する。
// フォーカス候補(focusMarkers)とその選択 UI(focusGizmo / overviewCameraPanel)は
// 「どこを注視するか」= overviewCamera 寄りの責務なので、ここが所有する。フォーカス選択メニューの
// ノードメニューとの排他(右クリックの取り合い)は上位(game.ts)が調停する。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly overviewCamera: OverviewCamera;
  readonly focusMarkers: FocusMarkers;
  private readonly focusGizmo = new FocusGizmo();
  // 広範囲視点の操作パネル(注視対象・視点の座標系・視点リセット)。映すのも受けるのも
  // overviewCamera の状態だけなので、この HUD 配線はここに閉じる。
  private readonly overviewCameraPanel: OverviewCameraPanel;
  // 広範囲視点に切り替わっているか。マップモード全体の正本は MapModeToggler.mapMode で、
  // これはその影響先の一つ(視点・描画側の判定に使う)。
  overviewMode = false;
  zoomActive = false;

  constructor(
    private readonly _hud: Hud,
    sfx: Sfx,
    markerManager: MarkerManager,
    ephemeris: Ephemeris,
  ) {
    this.focusMarkers = new FocusMarkers(markerManager, ephemeris);
    this.chaseCamera = new ChaseCamera(_hud, sfx);
    this.overviewCamera = new OverviewCamera(_hud, sfx, this.focusMarkers, ephemeris);
    this.focusGizmo.onMenuFocus = (targetKey) => {
      this.overviewCamera.focus = targetKey;
      const lbl = this.focusMarkers.findLabel(targetKey);
      if (lbl) this._hud.hint(`${lbl.name} にフォーカス`);
    };
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

  // マップ編集中のポインタ操作。ノードに消費されずに残った右クリックだけがここへ来るので、
  // 最寄りラベルがあればフォーカス選択メニューを開いて消費する。
  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleFocusRightClick(p.x, p.y));
  }

  // フォーカス候補ラベルの右クリック: 最寄りラベル(FOCUS_LABEL_PICK_PX 以内)が
  // あればフォーカス選択メニューを開いて true を返す。
  private handleFocusRightClick(clientX: number, clientY: number): boolean {
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
    if (bestKey === null) return false;
    this.focusGizmo.openMenu(clientX, clientY, bestKey);
    return true;
  }

  closeFocusMenu(): void {
    this.focusGizmo.closeMenu();
  }

  get activeCamera(): THREE.PerspectiveCamera {
    return this.overviewMode ? this.overviewCamera.camera : this.chaseCamera.camera;
  }

  get activeCameraPos(): Vec3 {
    return this.overviewMode ? this.overviewCamera.position : this.chaseCamera.position;
  }

  update(
    player: Player,
    simTime: number,
    input: Input,
    dt: number,
  ): void {
    // [G] 追従基準の切替はカメラ自身の状態なので、視点更新と同じ場所で受ける。
    if (input.takeKey(K.followAttitudeToggle)) this.chaseCamera.toggleFollowAttitude();
    this.zoomActive = !this.overviewMode && input.down(K.gunsightZoom);

    const keyYaw = (input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0);
    const keyPitch = (input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0);
    const mouse = input.mouse();

    if (this.overviewMode) {
      this.overviewCamera.update(mouse, keyYaw, keyPitch, dt, simTime);
    }
    else {
      this.chaseCamera.update(mouse, keyYaw, keyPitch, dt, player, this.zoomActive);
    }
  }

  // update() が算出した絶対 ECI の視点状態を、フローティングオリジン(fo)で補正して
  // 描画用のアクティブカメラへ反映する(平行移動のみ)。マーカー投影
  // (activeCameraProjection)や environment-scene がこの THREE.js カメラ姿勢を読むため、
  // game.sync() の先頭で(それらより先に)呼ぶ。
  sync(fo: FloatingOrigin, displayTime: number): void {
    if (this.overviewMode) this.overviewCamera.sync(fo);
    else this.chaseCamera.sync(fo);
    // 視点パネルは広範囲視点中だけ表示し、点灯状態を overviewCamera の現状へ揃える。フォーカスは
    // ラベル右クリックからも、座標系はリセットからも変わるので、変化点ごとの通知ではなく
    // 毎フレームここで押し出す(同値なら DOM は変わらない)。
    this.overviewCameraPanel.setVisible(this.overviewMode);
    if (this.overviewMode) {
      this.overviewCameraPanel.setFocus(this.overviewCamera.focus);
      this.overviewCameraPanel.setFrame(this.overviewCamera.cameraFrame);
      this.focusMarkers.syncLabels(displayTime, this.activeCameraProjection);
    } else {
      this.focusMarkers.hideLabels();
    }
  }


  get activeCameraProjection(): ProjectFn {
    return this.overviewMode ? this.overviewCamera.projection : this.chaseCamera.projection;
  }
}