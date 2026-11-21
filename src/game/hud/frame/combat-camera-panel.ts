// 戦闘ビューの「カメラ」パネル。回転モード切替と、視点の姿勢追従の切替を表示する。
// 視点追従はカメラの問いなので艦パネルではなくここに置く(UI-DESIGN.md §8)。
import { KEY_MAPPING as K } from '../../../input-devices/key-mapping';
import { Button } from '../../../hud-kit/widgets';
import { CameraRotationModeControl, type CameraRotationModeCommands } from './camera-rotation-mode-control';
import { buildPanel } from './panel-shell';
import type { CameraRotationMode } from '../../viewer/camera-orientation';

// 戦闘カメラパネルの操作を受け付けるインターフェース。姿勢追従の切替は、
// G キーと同じ toggleAttitudeFollow 命令へ返す(サンプルは FrameControls が渡す)。
export interface CombatCameraCommands extends CameraRotationModeCommands {
  toggleAttitudeFollow(): void;
}

export class CombatCameraPanel {
  private readonly panel: HTMLElement;
  private readonly rotationModeControl: CameraRotationModeControl;
  private readonly followButton: Button;

  // panelRoot はパネル自身の設置先。回転モード・姿勢追従の切り替えは commands へ返す。
  public constructor(
    panelRoot: HTMLElement, commands: CombatCameraCommands, initialMode: CameraRotationMode,
    initialFollowsAttitude: boolean,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-combat-camera-controls', 'CAMERA BASIS', 'CAM');
    this.panel.classList.add('hud-frame-controls-compact');
    this.rotationModeControl = new CameraRotationModeControl(commands, initialMode);
    this.panel.appendChild(this.rotationModeControl.element);
    this.followButton = new Button(
      '視点追従', () => commands.toggleAttitudeFollow(),
      undefined, ['dense', 'secondary'], K.followAttitudeToggle.label,
    );
    this.followButton.element.classList.add('camera-attitude-follow');
    this.followButton.element.title = '視点のRCS追従を切り替える';
    this.followButton.element.setAttribute('aria-label', `視点追従、キー ${K.followAttitudeToggle.label}`);
    this.followButton.element.setAttribute('aria-keyshortcuts', K.followAttitudeToggle.label);
    this.followButton.setOn(initialFollowsAttitude);
    this.panel.appendChild(this.followButton.element);
  }

  // 現在の回転モードと姿勢追従の状態をトグル・ボタンへ反映する。
  public sync(mode: CameraRotationMode, followsAttitude: boolean): void {
    this.rotationModeControl.sync(mode);
    this.followButton.setOn(followsAttitude);
  }

  // パネル要素を片付ける。
  public dispose(): void {
    this.panel.remove();
  }
}
