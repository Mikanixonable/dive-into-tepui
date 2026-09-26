// マップと戦闘のカメラパネル、およびマップの軌道フレームパネルを所有する。
import { FRAME_ROLES, type FrameAnchorSource, type FrameRole } from '../../../physics/frame';
import type { Vec3 } from '../../../math/vec3';
import type { OverlayManager } from '../../../hud/overlay-manager';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ListedObject } from '../../pickable/listed-object';
import type { FocusCameraCommands } from '../../viewer/camera-commands';
import type { CameraFrameSample, FocusCameraSource } from '../../viewer/focus-camera-selection';
import { focusPoint, focusTargetId, type FocusTarget } from '../../viewer/focus-target';
import type { PredictPanelCommands } from '../../viewer/predict-panel-commands';
import type { PredictPanelSource } from '../../viewer/predict-panel-selection';
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
    predictPanel: Pick<PredictPanelSource, 'frame' | 'followCamera'>,
    private readonly predictPanelCommands: Pick<
      PredictPanelCommands,
      'setFrameCenter' | 'setFrameRotation' | 'setFollowCamera' | 'followCameraFocus'
    >,
    overlayManager: OverlayManager,
    private readonly frameAnchors: FrameAnchorSource,
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
      mapPanelRoot, celestialBodies, predictPanel, predictPanelCommands, overlayManager,
    );
    this.cameraPanel.onSelectCenter = (id) => this.selectCameraCenter(id);
  }

  // 時刻 t に周回軌道を描いている役割を、回転基準の選択肢として返す。
  private validRevolutionRoles(t: number): readonly FrameRole[] {
    return FRAME_ROLES.filter((role) => this.frameAnchors.attractorOf(`@${role}`, t) !== null);
  }

  // カメラの基準を選ぶ。null は現在の注視位置を恒星中心慣性系へ固定する。
  private selectCameraCenter(id: string | null): void {
    if (id !== null) {
      this.setFocus({ kind: 'object', id });
      return;
    }
    const sample = this.cameraPresentation.sample('map');
    const frames = this.celestialBodies.frames;
    const starId = this.celestialBodies.starId;
    const frame = starId !== null ? frames.frameOf(starId, null) : frames.inertialFrame;
    this.setFocus(focusPoint(
      frames,
      frame,
      this.cameraPresentation.mapResolvedFocus,
      sample.displayTime,
      sample.frameAnchors,
    ));
  }

  // マップカメラの注視と、追随中の予測パネル基準を同じ命令列へ積む。
  public setFocus(target: FocusTarget): void {
    this.mapCameraCommands.setFocus(target);
    this.predictPanelCommands.followCameraFocus(focusTargetId(target));
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
    this.trajectoryPanel.sync(pickables, members, displayTime, this.validRevolutionRoles(displayTime));
  }

  // 持っている3枚のパネルを畳む。
  public dispose(): void {
    this.cameraPanel.dispose();
    this.combatCameraPanel.dispose();
    this.trajectoryPanel.dispose();
  }
}
