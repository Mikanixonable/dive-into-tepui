// マップと戦闘のカメラパネル、およびマップの軌道フレームパネルを所有する。
import type { FrameAnchorSource } from '../../../physics/frame';
import type { Vec3 } from '../../../math/vec3';
import type { OverlayManager } from '../../../hud/overlay-manager';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ListedObject } from '../../pickable/listed-object';
import type { FocusCameraCommands } from '../../viewer/camera-commands';
import type { CameraFrameSample, FocusCameraSource } from '../../viewer/focus-camera-selection';
import { focusTargetId, starInertialFocusPoint, type FocusTarget } from '../../viewer/focus-target';
import type { DisplayTimelineCommands } from '../../viewer/display-timeline-commands';
import type { DisplayTimelineSource } from '../../viewer/display-timeline-selection';
import { CameraFramePanel, type CameraFrameCommands } from './camera-frame-panel';
import { CombatCameraPanel } from './combat-camera-panel';
import { TrajectoryFramePanel } from './trajectory-frame-panel';

interface CameraFramePresentation {
  readonly mapResolvedFocus: Vec3;
  sample(view: 'combat' | 'map'): CameraFrameSample;
}

export class FrameControls {
  private readonly cameraPanel: CameraFramePanel;
  private readonly combatCameraPanel: CombatCameraPanel;
  private readonly trajectoryPanel: TrajectoryFramePanel;

  // パネル操作を命令の列へ返し、表示値は読み取り面から同期する。
  public constructor(
    mapPanelRoot: HTMLElement,
    combatPanelRoot: HTMLElement,
    private readonly celestialBodies: CelestialBodies,
    private readonly mapCamera: Pick<
      FocusCameraSource,
      | 'focus'
      | 'rotationFollow'
      | 'availableRotationFollows'
      | 'cameraRotationMode'
      | 'projection'
      | 'fov'
      | 'referencePlane'
    >,
    private readonly combatCamera: Pick<FocusCameraSource, 'cameraRotationMode'>,
    private readonly mapCameraCommands: FocusCameraCommands,
    combatCameraCommands: Pick<FocusCameraCommands, 'setCameraRotationMode'>,
    private readonly cameraPresentation: CameraFramePresentation,
    displayTimeline: Pick<DisplayTimelineSource, 'frame' | 'followCamera'>,
    private readonly displayTimelineCommands: Pick<
      DisplayTimelineCommands,
      'setFrameCenter' | 'setFrameRotation' | 'setFollowCamera' | 'followCameraFocus'
    >,
    overlayManager: OverlayManager,
    frameAnchors: Pick<FrameAnchorSource, 'attractorOf'>,
  ) {
    const mapCommands: CameraFrameCommands = {
      setRotationFollow: (follow) => mapCameraCommands.setRotationFollow(
        follow, cameraPresentation.sample('map'),
      ),
      setCameraRotationMode: (mode) => mapCameraCommands.setCameraRotationMode(mode),
      setProjectionMode: (mode) => mapCameraCommands.setProjectionMode(mode),
      setFovDeg: (fovDeg) => mapCameraCommands.setFovDeg(fovDeg),
      resetFov: () => mapCameraCommands.resetFov(),
      setReferencePlane: (plane) => mapCameraCommands.setReferencePlane(plane),
      setReferenceView: (view) => mapCameraCommands.setReferenceView(
        view, cameraPresentation.sample('map'),
      ),
    };
    this.cameraPanel = new CameraFramePanel(
      mapPanelRoot, celestialBodies, mapCommands, overlayManager, mapCamera.cameraRotationMode,
    );
    this.combatCameraPanel = new CombatCameraPanel(
      combatPanelRoot, combatCameraCommands, combatCamera.cameraRotationMode,
    );
    this.trajectoryPanel = new TrajectoryFramePanel(
      mapPanelRoot, celestialBodies, displayTimeline, displayTimelineCommands, frameAnchors, overlayManager,
    );
    this.cameraPanel.onSelectCenter = (id) => this.selectCameraCenter(id);
  }

  // カメラの基準を選ぶ。null は現在の注視位置を恒星中心慣性系へ固定する。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const sample = this.cameraPresentation.sample('map');
    this.setFocus(starInertialFocusPoint(
      this.celestialBodies.frames,
      this.celestialBodies.starId,
      this.cameraPresentation.mapResolvedFocus,
      sample.displayTime,
      sample.frameAnchors,
    ));
  }

  // マップカメラの注視と、追随中のタイムラインパネル基準を同じ命令列へ積む。
  public setFocus(target: FocusTarget): void {
    this.mapCameraCommands.setFocus(target);
    this.displayTimelineCommands.followCameraFocus(focusTargetId(target));
  }

  // パネルの選択肢と選択表示を、現在の視点と天体系へ合わせる。
  public sync(pickables: readonly ListedObject[], cameraPos: Vec3, displayTime: number): void {
    const members = this.celestialBodies.systemMembersAt(cameraPos, displayTime);
    const sample = this.cameraPresentation.sample('map');
    this.cameraPanel.sync(pickables, members, {
      focusId: focusTargetId(this.mapCamera.focus) ?? null,
      rotationFollow: this.mapCamera.rotationFollow,
      availableRotationFollows: this.mapCamera.availableRotationFollows(sample),
      cameraRotationMode: this.mapCamera.cameraRotationMode,
      projection: this.mapCamera.projection,
      fovDeg: this.mapCamera.fov,
      referencePlane: this.mapCamera.referencePlane,
    });
    this.combatCameraPanel.sync(this.combatCamera.cameraRotationMode);
    this.trajectoryPanel.sync(pickables, members, displayTime);
  }

  // 持っている3枚のパネルを畳む。
  public dispose(): void {
    this.cameraPanel.dispose();
    this.combatCameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
