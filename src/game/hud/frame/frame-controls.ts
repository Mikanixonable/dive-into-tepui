// マップの統合座標系パネル(視点+軌道フレーム)と、戦闘の簡易カメラパネルを所有する。
import type { FrameAnchorSource, FrameRotationSource } from '../../../physics/frame';
import type { Vec3 } from '../../../math/vec3';
import type { OverlayManager } from '../../../hud/overlay-manager';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { MapVisibilityPolicy } from '../../map/visibility-policy';
import type { ListedObject } from '../../pickable/listed-object';
import type { FocusCameraCommands } from '../../viewer/camera-commands';
import type { CameraFrameSample, CameraRotationFollow, FocusCameraSource } from '../../viewer/focus-camera-selection';
import { focusTargetId, starInertialFocusPoint, type FocusTarget } from '../../viewer/focus-target';
import type { DisplayTimelineCommands } from '../../viewer/display-timeline-commands';
import type { DisplayTimelineSource } from '../../viewer/display-timeline-selection';
import { CombatCameraPanel, type CombatCameraCommands } from './combat-camera-panel';
import { MapFramePanel, type MapFrameCommands } from './map-frame-panel';

interface CameraFramePresentation {
  readonly mapResolvedFocus: Vec3;
  sample(view: 'combat' | 'map'): CameraFrameSample;
}

// カメラの回転追従のうち、軌道フレーム側へ写せる成分(公転・自転・慣性)だけを抜き出す。
// 姿勢追従(attitude)は軌道描画の座標系には無いため慣性系(null)へ落とす。
function frameRotationFromCamera(follow: CameraRotationFollow | null): FrameRotationSource | null {
  return follow === null || follow.kind === 'attitude' ? null : follow;
}

export class FrameControls {
  private readonly mapPanel: MapFramePanel;
  private readonly combatCameraPanel: CombatCameraPanel;

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
    private readonly combatCamera: Pick<FocusCameraSource, 'cameraRotationMode' | 'rotationFollow'>,
    private readonly mapCameraCommands: FocusCameraCommands,
    combatCameraCommands: Pick<FocusCameraCommands, 'setCameraRotationMode' | 'toggleAttitudeFollow'>,
    private readonly cameraPresentation: CameraFramePresentation,
    displayTimeline: Pick<DisplayTimelineSource, 'frame' | 'followCamera'>,
    private readonly displayTimelineCommands: Pick<
      DisplayTimelineCommands,
      | 'setFrameCenter'
      | 'setFrameRotation'
      | 'setFollowCamera'
      | 'followCameraFocus'
      | 'followCameraRotation'
    >,
    overlayManager: OverlayManager,
    frameAnchors: Pick<FrameAnchorSource, 'attractorOf'>,
  ) {
    const mapCommands: MapFrameCommands = {
      selectCameraCenter: (id) => this.selectCameraCenter(id),
      setRotationFollow: (follow) => {
        mapCameraCommands.setRotationFollow(follow, cameraPresentation.sample('map'));
        displayTimelineCommands.followCameraRotation(frameRotationFromCamera(follow));
      },
      setCameraRotationMode: (mode) => mapCameraCommands.setCameraRotationMode(mode),
      setProjectionMode: (mode) => mapCameraCommands.setProjectionMode(mode),
      setFovDeg: (fovDeg) => mapCameraCommands.setFovDeg(fovDeg),
      resetFov: () => mapCameraCommands.resetFov(),
      setReferencePlane: (plane) => mapCameraCommands.setReferencePlane(plane),
      setReferenceView: (view) => mapCameraCommands.setReferenceView(
        view, cameraPresentation.sample('map'),
      ),
      setFrameCenter: (id) => displayTimelineCommands.setFrameCenter(id),
      setFrameRotation: (rotatingWith) => displayTimelineCommands.setFrameRotation(rotatingWith),
      setFollowCamera: (on) => {
        displayTimelineCommands.setFollowCamera(on);
        // 軌道連動を再開した瞬間、現在のカメラの中心と回転へ軌道側も揃える。
        if (on) {
          displayTimelineCommands.followCameraFocus(focusTargetId(mapCamera.focus));
          displayTimelineCommands.followCameraRotation(frameRotationFromCamera(mapCamera.rotationFollow));
        }
      },
    };
    this.mapPanel = new MapFramePanel(
      mapPanelRoot, celestialBodies, displayTimeline, mapCommands, frameAnchors,
      overlayManager, mapCamera.cameraRotationMode,
    );

    // 姿勢追従の切替は戦闘カメラのサンプルで toggleAttitudeFollow へ返す —
    // マップ側の setRotationFollow が sample('map') を渡すのと同じ経路。
    const combatCommands: CombatCameraCommands = {
      setCameraRotationMode: (mode) => combatCameraCommands.setCameraRotationMode(mode),
      toggleAttitudeFollow: () => combatCameraCommands.toggleAttitudeFollow(
        cameraPresentation.sample('combat'),
      ),
    };
    this.combatCameraPanel = new CombatCameraPanel(
      combatPanelRoot, combatCommands, combatCamera.cameraRotationMode,
      combatCamera.rotationFollow?.kind === 'attitude',
    );
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
  public sync(
    pickables: readonly ListedObject[], cameraPos: Vec3, displayTime: number,
    visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const members = this.celestialBodies.systemMembersAt(cameraPos, displayTime);
    const sample = this.cameraPresentation.sample('map');
    this.mapPanel.sync(pickables, members, displayTime, {
      focusId: focusTargetId(this.mapCamera.focus) ?? null,
      rotationFollow: this.mapCamera.rotationFollow,
      availableRotationFollows: this.mapCamera.availableRotationFollows(sample),
      cameraRotationMode: this.mapCamera.cameraRotationMode,
      projection: this.mapCamera.projection,
      fovDeg: this.mapCamera.fov,
      referencePlane: this.mapCamera.referencePlane,
    }, visibilityPolicy);
    this.combatCameraPanel.sync(
      this.combatCamera.cameraRotationMode,
      this.combatCamera.rotationFollow?.kind === 'attitude',
    );
  }

  // 持っている2枚のパネルを畳む。
  public dispose(): void {
    this.mapPanel.dispose();
    this.combatCameraPanel.dispose();
  }
}
