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
// フォーカス候補(focusMarkers)とその選択 UI(focusGizmo / overviewCameraPanel)も所有する。
export class CameraSystem {
  readonly chaseCamera: ChaseCamera;
  readonly overviewCamera: OverviewCamera;
  readonly focusMarkers: FocusMarkers;
  private readonly focusGizmo = new FocusGizmo();
  // 広範囲視点の操作パネル(注視対象・視点の座標系・視点リセット)。
  private readonly overviewCameraPanel: OverviewCameraPanel;
  // 広範囲視点に切り替わっているか(視点・描画側の判定に使う)。
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

  // マップ編集中のポインタ操作。最寄りラベルがあればフォーカス選択メニューを開いて消費する。
  handleMapPointer(input: Input): void {
    input.takeRightClicks((p) => this.handleFocusRightClick(p.x, p.y));
  }

  // 最寄りラベル(FOCUS_LABEL_PICK_PX 以内)があればフォーカス選択メニューを開いて true を返す。
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

  // 視点状態をフローティングオリジン(fo)で補正してアクティブカメラへ反映する。
  sync(fo: FloatingOrigin, displayTime: number): void {
    if (this.overviewMode) this.overviewCamera.sync(fo);
    else this.chaseCamera.sync(fo);
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