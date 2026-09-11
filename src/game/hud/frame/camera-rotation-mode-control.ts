// カメラの回転モードを切り替える共通トグル。マップの詳細パネルと戦闘の簡易パネルで
// 共有する。
import { ToggleSwitch } from '../../../hud/widgets';
import type { FocusCamera } from '../../camera/focus-camera';

export class CameraRotationModeControl {
  public readonly element: HTMLElement;
  private readonly toggle: ToggleSwitch;

  public constructor(private readonly camera: FocusCamera) {
    this.toggle = new ToggleSwitch('クォータニオン操作', (on) => {
      this.camera.setCameraRotationMode(on ? 'quaternion' : 'euler');
    });
    this.element = this.toggle.element;
    this.sync();
  }

  // 保存値を含むカメラの現在の操作モードをトグルへ反映する。
  public sync(): void {
    this.toggle.setOn(this.camera.cameraRotationMode === 'quaternion');
  }
}
