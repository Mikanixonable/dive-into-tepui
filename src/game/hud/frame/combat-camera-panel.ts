// 戦闘ビューの「カメラ」パネル。戦闘中に必要な回転モード切替だけを表示する。
import type { FocusCamera } from '../../camera/focus-camera';
import { CameraRotationModeControl } from './camera-rotation-mode-control';
import { buildPanel } from './frame-controls';

export class CombatCameraPanel {
  private readonly panel: HTMLElement;
  private readonly rotationModeControl: CameraRotationModeControl;

  public constructor(panelRoot: HTMLElement, camera: FocusCamera) {
    this.panel = buildPanel(panelRoot, 'hud-combat-camera-controls', 'カメラ');
    this.rotationModeControl = new CameraRotationModeControl(camera);
    this.panel.appendChild(this.rotationModeControl.element);
  }

  public sync(): void {
    this.rotationModeControl.sync();
  }

  public dispose(): void {
    this.panel.remove();
  }
}
