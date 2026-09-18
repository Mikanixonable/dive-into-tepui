// 戦闘・マップの2台のカメラ視点を所有し、進行に合わせる規則と保存をまとめる。
import { frameRoleAnchorId } from '../../physics/frame';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { RunEvent, RunEventSink } from '../run-events';
import type { ViewMode } from '../view/view-mode';
import {
  type CameraFrameSample,
  FocusCameraSelection,
  type FocusCameraSource,
  type SerializedFocusCameraSelection,
} from './focus-camera-selection';

export const COMBAT_CAMERA_FOV = 55; // 通常時の垂直画角 [deg]
const COMBAT_CAMERA_INIT_DIST = 38; // 注視距離 [m]

export interface SerializedCameraSelection {
  readonly view: 'combat' | 'map';
  // 戦闘ビューの視点。
  readonly chase: SerializedFocusCameraSelection;
  // マップビューの視点。
  readonly overview: SerializedFocusCameraSelection;
}

export interface CameraFrameSamples {
  readonly combat: CameraFrameSample;
  readonly map: CameraFrameSample;
}

// マップのカメラだけを読む面。マップ上の当たり判定・窓・計画編集・マップビューは、
// 2台ぶんではなくこれを受ける。
export interface MapCameraSource {
  readonly map: Pick<FocusCameraSource, 'focus' | 'distance'>;
}

// 2台のカメラ視点を読む面。
export interface CameraSelectionSource {
  readonly combat: FocusCameraSource;
  readonly map: FocusCameraSource;
  camera(view: ViewMode): FocusCameraSource;
}

export class CameraSelection implements CameraSelectionSource {
  public readonly combat: FocusCameraSelection;
  public readonly map: FocusCameraSelection;

  // 保存状態またはビューごとの既定から2台の視点を組む。
  public constructor(
    celestialBodies: CelestialBodies,
    events: RunEventSink,
    saved: SerializedCameraSelection | undefined,
  ) {
    this.combat = new FocusCameraSelection(celestialBodies, {
      view: 'combat',
      focusLossPolicy: 'hold',
      initial: {
        angles: { yaw: -Math.PI / 2, pitch: 0.3 - (10 * Math.PI) / 180, roll: 0 },
        dist: COMBAT_CAMERA_INIT_DIST,
        fovDeg: COMBAT_CAMERA_FOV,
        focus: { kind: 'object', id: frameRoleAnchorId('controlled') },
        follow: { kind: 'attitude' },
      },
      eulerPole: 'attitude',
      reset: 'initial',
    }, events, saved?.chase);
    this.map = new FocusCameraSelection(celestialBodies, {
      view: 'map',
      focusLossPolicy: 'fallToOrigin',
      initial: {
        angles: { yaw: 0.7, pitch: 0.45, roll: 0 },
        dist: 4.5e7,
        fovDeg: 50,
        focus: { kind: 'object', id: celestialBodies.originId },
        follow: null,
      },
      eulerPole: 'reference',
      reset: 'orientation',
    }, events, saved?.overview);
  }

  // view が表に出ているときに使う1台。
  public camera(view: ViewMode): FocusCameraSelection {
    return view === 'map' ? this.map : this.combat;
  }

  // 進行の出来事と、その直後の姿勢・座標系へ視点を追従させる。姿勢・座標系・注視の喪失に
  // 合わせるのは、表示している view のカメラだけ。
  public followProgress(events: readonly RunEvent[], samples: CameraFrameSamples, view: ViewMode): void {
    for (const { body } of events) {
      if (body.kind === 'controllableRemoved') this.map.clearFocusIf(body.id);
    }
    this.camera(view).followProgress(view === 'map' ? samples.map : samples.combat);
  }

  // 2台分を直列化した形へ畳む。
  public serialize(view: ViewMode): SerializedCameraSelection {
    return { view, chase: this.combat.serialize(), overview: this.map.serialize() };
  }
}
