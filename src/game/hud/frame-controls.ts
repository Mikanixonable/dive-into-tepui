// マップモードの「カメラ」「軌道フレーム」パネル オーケストレーター。
// マップカメラの視点 (CameraFramePanel) と未来表示の描画基準 (TrajectoryFramePanel) を所有し、
// カメラフォーカス変更時の軌道フレーム自動追随などの連動を疎結合に調停する。
import { bodyAnchorSource, CelestialBody } from '../../physics/celestial-body';
import type { Ephemeris } from '../../physics/ephemeris';
import { Vec3 } from '../../physics/vec3';
import { systemMembersAt } from '../celestial/body-visibility';
import { MapCamera } from '../camera/map-camera';
import { focusPoint, focusTargetId, FocusTarget } from '../camera/focus-target';
import type { MapPickable } from '../map-pickable';
import type { DisplayWindowManager } from '../display-window-manager';
import type { OverlayManager } from './overlay-manager';
import { CameraFramePanel } from './camera-frame-panel';
import { TrajectoryFramePanel } from './trajectory-frame-panel';

export class FrameControls {
  private readonly cameraPanel: CameraFramePanel;
  private readonly trajectoryPanel: TrajectoryFramePanel;
  // 固定解除は DOM イベント(フレームの外)から起きるので、直近の sync が見た時刻を控える。
  private lastTime = 0;

  public constructor(
    panelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly ephemeris: Ephemeris,
    private readonly mapCamera: MapCamera,
    private readonly displayWindow: DisplayWindowManager,
    overlayManager: OverlayManager,
  ) {
    this.cameraPanel = new CameraFramePanel(panelRoot, popupRoot, ephemeris, mapCamera, overlayManager);
    this.trajectoryPanel = new TrajectoryFramePanel(panelRoot, popupRoot, ephemeris, displayWindow, overlayManager);

    this.cameraPanel.onSelectCenter = (id) => this.selectCameraCenter(id);
  }

  // カメラの基準を選び直す。解除は、いま見ている位置を恒星中心の慣性系へ焼き込んだ
  // 固定点にする — どの天体にも追随しないが、視線はその場に留まる。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const starId = this.ephemeris.starId;
    const frame = starId !== null ? this.ephemeris.frameOf(starId, null) : this.ephemeris.inertialFrame;
    // 回さない(rotatingWith: null)ので基準は必ず登録天体 — 機体・役割トークンの解決は要らない。
    this.setFocus(focusPoint(this.ephemeris, frame, this.mapCamera.resolvedFocus, this.lastTime, bodyAnchorSource([])));
  }

  // マップカメラのフォーカスを target へ移す。追随が有効で target が登録天体を指しているときは
  // 計画折れ線の中心も同じ天体へ合わせる(回転側は現状を保つ)。
  public setFocus(target: FocusTarget): void {
    this.mapCamera.setFocusTarget(target);
    if (!this.trajectoryPanel.followCamera) return;
    const id = focusTargetId(target);
    if (id !== undefined && id in this.ephemeris.registry) {
      this.displayWindow.frame = this.ephemeris.frameOf(id, this.displayWindow.frame.rotatingWith);
    }
  }

  // パネルの表示と選択肢・選択表示を、他モジュールの状態へ合わせる。
  public sync(
    pickables: readonly MapPickable[], cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
    simTime: number, visible: boolean,
  ): void {
    this.lastTime = simTime;
    const members = visible ? systemMembersAt(this.ephemeris.registry, cameraPos, celestialBodies) : [];

    this.cameraPanel.sync(pickables, members, visible);
    this.trajectoryPanel.sync(pickables, members, visible);
  }

  // 両パネルと、保持している座標系選択ゾーンを片付ける。
  dispose(): void {
    this.cameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
