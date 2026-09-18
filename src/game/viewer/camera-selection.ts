// 戦闘・マップの2台のカメラ視点を所有し、進行に合わせる規則と保存をまとめる。
import { frameRoleAnchorId } from '../../physics/frame';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { RunEvent, RunEventSink } from '../run-events';
import type { ViewMode } from '../view/view-mode';
import {
  type CameraFrameSample,
  type FocusCameraConfig,
  FocusCameraSelection,
  type FocusCameraSource,
  type SerializedFocusCameraSelection,
} from './focus-camera-selection';

export const COMBAT_CAMERA_FOV = 55; // 通常時の垂直画角 [deg]
const COMBAT_CAMERA_INIT_DIST = 38; // 注視距離 [m]

export interface SerializedCameraSelection {
  // 戦闘ビューの視点。無ければ既定の視点から始まる。
  readonly chase?: SerializedFocusCameraSelection;
  // マップビューの視点。無ければ既定の視点から始まる。
  readonly overview?: SerializedFocusCameraSelection;
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

// 戦闘ビューのカメラの既定と規則。操作対象を後方から見て、その姿勢に追従する。
function combatCameraConfig(): FocusCameraConfig {
  return {
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
  };
}

// マップビューのカメラの既定と規則。原点天体 originId を慣性系で見る。
function mapCameraConfig(originId: string): FocusCameraConfig {
  return {
    view: 'map',
    focusLossPolicy: 'fallToOrigin',
    initial: {
      angles: { yaw: 0.7, pitch: 0.45, roll: 0 },
      dist: 4.5e7,
      fovDeg: 50,
      focus: { kind: 'object', id: originId },
      follow: null,
    },
    eulerPole: 'reference',
    reset: 'orientation',
  };
}

export class CameraSelection implements CameraSelectionSource {
  // 2台の視点から組む。省いた視点はビューごとの既定から始まる。
  public constructor(
    celestialBodies: CelestialBodies,
    events: RunEventSink,
    public readonly combat = new FocusCameraSelection(celestialBodies, combatCameraConfig(), events),
    public readonly map = new FocusCameraSelection(celestialBodies, mapCameraConfig(celestialBodies.originId), events),
  ) {}

  // 直列化した2台の視点から復元する。
  public static deserialize(
    serialized: SerializedCameraSelection, celestialBodies: CelestialBodies, events: RunEventSink,
  ): CameraSelection {
    const { chase, overview } = serialized;
    const combatConfig = combatCameraConfig();
    const mapConfig = mapCameraConfig(celestialBodies.originId);
    return new CameraSelection(
      celestialBodies,
      events,
      chase === undefined ? undefined : FocusCameraSelection.deserialize(chase, celestialBodies, combatConfig, events),
      overview === undefined ? undefined : FocusCameraSelection.deserialize(overview, celestialBodies, mapConfig, events),
    );
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
  public serialize(): SerializedCameraSelection {
    return { chase: this.combat.serialize(), overview: this.map.serialize() };
  }
}
