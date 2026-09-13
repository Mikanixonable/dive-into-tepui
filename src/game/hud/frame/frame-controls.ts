// マップビューの「カメラ」「軌道フレーム」パネルと、戦闘ビューのカメラパネルを所有し、カメラの
// 視点と未来表示の描画基準を選ばせる。
import { bodyAnchorSource } from '../../../physics/attractor';
import { FRAME_ROLES, FrameRole } from '../../../physics/frame';
import type { FrameAnchorSource } from '../../../physics/frame';
import { Vec3 } from '../../../math/vec3';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import { FocusCamera } from '../../camera/focus-camera';
import { focusPoint, focusTargetId, FocusTarget } from '../../camera/focus-target';
import type { DisplayFrameSelection } from '../../display-frame-selection';
import type { OverlayManager } from '../../../hud/overlay-manager';
import { CameraFramePanel } from './camera-frame-panel';
import { CombatCameraPanel } from './combat-camera-panel';
import { TrajectoryFramePanel } from './trajectory-frame-panel';
import type { ListedObject } from '../../pickable/listed-object';

export class FrameControls {
  private readonly cameraPanel: CameraFramePanel;
  private readonly combatCameraPanel: CombatCameraPanel;
  private readonly trajectoryPanel: TrajectoryFramePanel;
  // 固定解除は DOM イベント(フレームの外)から起きるので、直近の sync が見た時刻を控える。
  private lastTime = 0;

  // マップと戦闘のカメラパネル、マップの軌道フレームパネルを組む。各パネルのポップアップは
  // popupRoot へ出る。
  public constructor(
    mapPanelRoot: HTMLElement,
    combatPanelRoot: HTMLElement,
    popupRoot: HTMLElement,
    private readonly celestialBodies: CelestialBodies,
    private readonly mapCamera: FocusCamera,
    private readonly combatCamera: FocusCamera,
    private readonly displayFrame: DisplayFrameSelection,
    overlayManager: OverlayManager,
    private readonly frameAnchors: FrameAnchorSource,
  ) {
    this.cameraPanel = new CameraFramePanel(
      mapPanelRoot, popupRoot, celestialBodies, mapCamera, overlayManager, mapCamera.cameraRotationMode,
    );
    this.combatCameraPanel = new CombatCameraPanel(
      combatPanelRoot, combatCamera, combatCamera.cameraRotationMode,
    );
    this.trajectoryPanel = new TrajectoryFramePanel(
      mapPanelRoot, popupRoot, celestialBodies, displayFrame, overlayManager,
    );

    this.cameraPanel.onSelectCenter = (id) => this.selectCameraCenter(id);
  }

  // 時刻 t に周回軌道を描いている役割を、回転の基準の選択肢として返す。
  private validRevolutionRoles(t: number): readonly FrameRole[] {
    return FRAME_ROLES.filter((role) => this.frameAnchors.attractorOf(`@${role}`, t) !== null);
  }

  // カメラの基準を選び直す。id が null なら、いま見ている位置を恒星中心の慣性系へ
  // 焼き込んだ固定点にする。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const frames = this.celestialBodies.frames;
    const starId = this.celestialBodies.starId;
    const frame = starId !== null ? frames.frameOf(starId, null) : frames.inertialFrame;
    // 回さないので基準は必ず登録天体で、機体・役割トークンを解く材料が要らない。
    this.setFocus(focusPoint(
      this.celestialBodies.frames, frame, this.mapCamera.resolvedFocus, this.lastTime, bodyAnchorSource([], this.lastTime),
    ));
  }

  // マップカメラのフォーカスを target へ移し、移った先を描画基準の所有者へ伝える。
  public setFocus(target: FocusTarget): void {
    this.mapCamera.setFocusTarget(target);
    this.displayFrame.followCameraFocus(focusTargetId(target));
  }

  // 両パネルの選択肢と選択表示を、いまの天体系とカメラ位置へ合わせる。
  public sync(
    pickables: readonly ListedObject[], cameraPos: Vec3,
    simTime: number, displayTime: number,
  ): void {
    this.lastTime = simTime;
    const members = this.celestialBodies.systemMembersAt(cameraPos, displayTime);
    const camera = this.mapCamera;
    // マップカメラの現在値を写してから、3つのパネルを同じ候補列で揃える。
    this.cameraPanel.sync(pickables, members, {
      focusId: focusTargetId(camera.focus) ?? null,
      rotationFollow: camera.rotationFollow,
      availableRotationFollows: camera.availableRotationFollows(displayTime),
      cameraRotationMode: camera.cameraRotationMode,
      projection: camera.projection,
      fovDeg: camera.fov,
      referencePlane: camera.referencePlane,
    });
    this.combatCameraPanel.sync(this.combatCamera.cameraRotationMode);
    this.trajectoryPanel.sync(pickables, members, displayTime, this.validRevolutionRoles(displayTime));
  }

  // 各パネルを片付ける。
  public dispose(): void {
    this.cameraPanel.dispose();
    this.combatCameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
