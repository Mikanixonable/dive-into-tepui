// カメラ視点へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { ProjectionMode } from '../../math/projection';
import type { CommandQueue } from '../command-queue';
import type { ViewMode } from '../view/view-mode';
import type { CameraRotationMode } from './camera-orientation';
import type { CameraSelection } from './camera-selection';
import type {
  CameraFrameSample,
  CameraInput,
  CameraReferencePlane,
  CameraReferenceView,
  CameraRotationFollow,
  FocusCameraSelection,
} from './focus-camera-selection';
import type { FocusTarget } from './focus-target';

// 1台のカメラ視点を変える命令。受け付けるだけで、適用は次の進行の位相。
export interface FocusCameraCommands {
  setFocus(target: FocusTarget): void;
  setDistance(distance: number): void;
  applyInput(input: CameraInput, sample: CameraFrameSample): void;
  reset(sample: CameraFrameSample): void;
  toggleAttitudeFollow(sample: CameraFrameSample): void;
  setRotationFollow(follow: CameraRotationFollow | null, sample: CameraFrameSample): void;
  setCameraRotationMode(mode: CameraRotationMode): void;
  setProjectionMode(mode: ProjectionMode): void;
  setFovDeg(fovDeg: number): void;
  resetFov(): void;
  setReferencePlane(plane: CameraReferencePlane): void;
  setReferenceView(view: CameraReferenceView, sample: CameraFrameSample): void;
}

export interface CameraCommands {
  readonly combat: FocusCameraCommands;
  readonly map: FocusCameraCommands;
  camera(view: ViewMode): FocusCameraCommands;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
function focusCameraCommands(
  queue: CommandQueue,
  selection: FocusCameraSelection,
): FocusCameraCommands {
  return {
    setFocus: (target) => queue.submit(() => selection.setFocus(target)),
    setDistance: (distance) => queue.submit(() => selection.setDistance(distance)),
    applyInput: (input, sample) => queue.submit(() => selection.applyInput(input, sample)),
    reset: (sample) => queue.submit(() => selection.reset(sample)),
    toggleAttitudeFollow: (sample) => queue.submit(() => selection.toggleAttitudeFollow(sample)),
    setRotationFollow: (follow, sample) => queue.submit(() => selection.setRotationFollow(follow, sample)),
    setCameraRotationMode: (mode) => queue.submit(() => selection.setCameraRotationMode(mode)),
    setProjectionMode: (mode) => queue.submit(() => selection.setProjectionMode(mode)),
    setFovDeg: (fovDeg) => queue.submit(() => selection.setFovDeg(fovDeg)),
    resetFov: () => queue.submit(() => selection.resetFov()),
    setReferencePlane: (plane) => queue.submit(() => selection.setReferencePlane(plane)),
    setReferenceView: (view, sample) => queue.submit(() => selection.setReferenceView(view, sample)),
  };
}

// 2台の所有者へコマンドをエンキューするインターフェースを構築する。
export function cameraCommands(queue: CommandQueue, selection: CameraSelection): CameraCommands {
  const combat = focusCameraCommands(queue, selection.combat);
  const map = focusCameraCommands(queue, selection.map);
  return { combat, map, camera: (view) => view === 'map' ? map : combat };
}
