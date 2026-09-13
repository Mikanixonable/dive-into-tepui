// カメラの回転モードを切り替える共通トグル。マップの詳細パネルと戦闘の簡易パネルで
// 共有する。
import { ToggleSwitch } from '../../../hud/widgets';
import type { CameraRotationMode } from '../../camera/camera-orientation';

// 回転モードのトグルが返す操作。カメラの正本が公開する命令。
export interface CameraRotationModeCommand {
  setCameraRotationMode(mode: CameraRotationMode): void;
}

export class CameraRotationModeControl {
  public readonly element: HTMLElement;
  private readonly toggle: ToggleSwitch;

  // 初期の操作モードを点灯させ、以後の切り替えを command へ返す。
  public constructor(command: CameraRotationModeCommand, initialMode: CameraRotationMode) {
    this.toggle = new ToggleSwitch('クォータニオン操作', (on) => {
      command.setCameraRotationMode(on ? 'quaternion' : 'euler');
    });
    this.element = this.toggle.element;
    this.sync(initialMode);
  }

  // 現在の操作モードをトグルへ反映する。
  public sync(mode: CameraRotationMode): void {
    this.toggle.setOn(mode === 'quaternion');
  }
}
