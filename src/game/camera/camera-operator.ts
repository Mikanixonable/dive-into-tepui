// 生のキー・ポインタ入力を、1フレーム分のカメラ操作量へ解釈する。
import type { Input, MouseDelta } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { Viewport } from '../../render/viewport';
import type { CameraInput } from '../viewer/focus-camera-selection';

const CAM_KEY_YAW_RATE = 1.4; // キーによるヨー [rad/s]
const CAM_KEY_PITCH_RATE = 1.0; // キーによるピッチ [rad/s]
const CAM_KEY_ROLL_RATE = 1.4; // キーによるロール [rad/s]
const CAM_KEY_PAN_RATE = 600; // キーによるパン [px/s]
const DRAG_RAD_PER_PX = 0.005; // ドラッグ1pxあたりの回転量 [rad]
const WHEEL_ZOOM_RATE = 0.0015; // ホイール量を指数ズーム率へ換算する係数

export interface CameraOperatorResult {
  readonly input: CameraInput;
  readonly rollReset: boolean;
}

// 押下中キーとポインタ差分を、ビュー状態に依存しない操作量へ換算する。
export function cameraOperation(
  input: Pick<Input, 'down' | 'mouse'>,
  dt: number,
  viewport: Pick<Viewport, 'height'>,
  suppressMotion: boolean,
): CameraOperatorResult {
  const keyRollLeft = input.down(K.cameraRollLeft);
  const keyRollRight = input.down(K.cameraRollRight);
  const motionScale = suppressMotion ? 0 : 1;
  const mouse: MouseDelta = suppressMotion
    ? { ...input.mouse(), dx: 0, dy: 0, wheel: 0, panDx: 0, panDy: 0, roll: 0 }
    : { ...input.mouse() };
  const keyPanX = (input.down(K.cameraPanLeft) ? 1 : 0) + (input.down(K.cameraPanRight) ? -1 : 0);
  const keyPanY = (input.down(K.cameraPanUp) ? 1 : 0) + (input.down(K.cameraPanDown) ? -1 : 0);
  const keyRoll = (keyRollLeft ? 1 : 0) + (keyRollRight ? -1 : 0);
  return {
    input: {
      zoomFactor: Math.exp(mouse.wheel * WHEEL_ZOOM_RATE),
      dragRightRad: mouse.dx * DRAG_RAD_PER_PX,
      dragUpRad: -mouse.dy * DRAG_RAD_PER_PX,
      rollRad: mouse.roll + keyRoll * CAM_KEY_ROLL_RATE * dt * motionScale,
      keyYawRad: ((input.down(K.cameraYawLeft) ? 1 : 0) + (input.down(K.cameraYawRight) ? -1 : 0))
        * CAM_KEY_YAW_RATE * dt * motionScale,
      keyPitchRad: ((input.down(K.cameraPitchDown) ? 1 : 0) + (input.down(K.cameraPitchUp) ? -1 : 0))
        * CAM_KEY_PITCH_RATE * dt * motionScale,
      panDx: mouse.panDx + keyPanX * CAM_KEY_PAN_RATE * dt * motionScale,
      panDy: mouse.panDy + keyPanY * CAM_KEY_PAN_RATE * dt * motionScale,
      viewportHeight: viewport.height,
    },
    rollReset: keyRollLeft && keyRollRight,
  };
}
