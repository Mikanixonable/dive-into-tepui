// カメラの回転モードを切り替える共通トグル。マップの詳細パネルと戦闘の簡易パネルで
// 共有する。
import { ToggleSwitch } from '../../../hud/widgets';
import type { CameraRotationMode } from '../../viewer/camera-orientation';

// 回転モードの切り替えを受け付けるインターフェース。
export interface CameraRotationModeCommands {
  setCameraRotationMode(mode: CameraRotationMode): void;
}

export class CameraRotationModeControl {
  public readonly element: HTMLElement;
  private readonly toggle: ToggleSwitch;

  // 初期の操作モードを点灯させ、以後の切り替えを commands へ返す。
  public constructor(commands: CameraRotationModeCommands, initialMode: CameraRotationMode) {
    this.toggle = new ToggleSwitch('クォータニオン操作', (on) => {
      commands.setCameraRotationMode(on ? 'quaternion' : 'euler');
    });
    this.element = this.toggle.element;
    this.sync(initialMode);
  }

  // 現在の操作モードをトグルへ反映する。
  public sync(mode: CameraRotationMode): void {
    this.toggle.setOn(mode === 'quaternion');
  }
}
