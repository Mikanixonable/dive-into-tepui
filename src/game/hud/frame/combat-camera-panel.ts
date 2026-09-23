// 戦闘ビューの「カメラ」パネル。戦闘中に必要な回転モード切替だけを表示する。
import { CameraRotationModeControl, type CameraRotationModeCommands } from './camera-rotation-mode-control';
import { buildPanel } from './frame-panel';
import type { CameraRotationMode } from '../../viewer/camera-orientation';

export class CombatCameraPanel {
  private readonly panel: HTMLElement;
  private readonly rotationModeControl: CameraRotationModeControl;

  // panelRoot はパネル自身の設置先。回転モードの切り替えは commands へ返す。
  public constructor(
    panelRoot: HTMLElement, commands: CameraRotationModeCommands, initialMode: CameraRotationMode,
  ) {
    this.panel = buildPanel(panelRoot, 'hud-combat-camera-controls', 'CAMERA BASIS', 'CAM');
    this.panel.classList.add('hud-frame-controls-compact');
    this.rotationModeControl = new CameraRotationModeControl(commands, initialMode);
    this.panel.appendChild(this.rotationModeControl.element);
  }

  // 現在の回転モードをトグルへ反映する。
  public sync(mode: CameraRotationMode): void {
    this.rotationModeControl.sync(mode);
  }

  // パネル要素を片付ける。
  public dispose(): void {
    this.panel.remove();
  }
}
