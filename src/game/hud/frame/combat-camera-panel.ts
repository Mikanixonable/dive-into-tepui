// 戦闘ビューの「カメラ」パネル。視点の回し方(回転モード・RCS 姿勢への追従)だけを表示する。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { ToggleSwitch } from '../../../hud/widgets';
import { CameraRotationModeControl, type CameraRotationModeCommands } from './camera-rotation-mode-control';
import { buildPanel } from './frame-panel';
import type { CameraRotationMode } from '../../viewer/camera-orientation';

// 戦闘カメラのパネル操作。姿勢追従は現在の状態の反転で、結果は次の sync で表示へ戻る。
export interface CombatCameraCommands extends CameraRotationModeCommands {
  toggleAttitudeFollow(): void;
}

export class CombatCameraPanel {
  private readonly panel: HTMLElement;
  private readonly rotationModeControl: CameraRotationModeControl;
  private readonly followToggle: ToggleSwitch;

  // panelRoot はパネル自身の設置先。パネルの操作は commands へ返す。
  public constructor(
    panelRoot: HTMLElement, commands: CombatCameraCommands, initialMode: CameraRotationMode,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-combat-camera-controls', 'カメラ', 'CAM');
    this.panel.classList.add('hud-frame-controls-compact');
    this.rotationModeControl = new CameraRotationModeControl(commands, initialMode);
    this.followToggle = new ToggleSwitch(
      'RCS 姿勢に追従', () => commands.toggleAttitudeFollow(), K.followAttitudeToggle.label,
    );
    this.panel.append(this.rotationModeControl.element, this.followToggle.element);
  }

  // 現在の回転モードと姿勢追従の有無をトグルへ反映する。
  public sync(mode: CameraRotationMode, followsAttitude: boolean): void {
    this.rotationModeControl.sync(mode);
    this.followToggle.setOn(followsAttitude);
  }

  // パネル要素を片付ける。
  public dispose(): void {
    this.panel.remove();
  }
}
