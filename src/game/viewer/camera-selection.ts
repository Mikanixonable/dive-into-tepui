// 戦闘・マップの2台のカメラ視点を所有し、進行に合わせる規則と直列化をまとめる。
import { frameRoleAnchorId } from '../../physics/frame';
import {
  type CameraFrameSample,
  type FocusCameraConfig,
  FocusCameraSelection,
  type FocusCameraSource,
  type SerializedFocusCameraSelection,
} from './focus-camera-selection';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { RunEvent, RunEventSink } from '../run-events';
import type { ViewMode } from '../view/view-mode';

export const COMBAT_CAMERA_FOV = 55; // 通常時の垂直画角 [deg]
const COMBAT_CAMERA_INIT_DIST = 38; // 注視距離 [m]

export interface SerializedCameraSelection {
  readonly combat: SerializedFocusCameraSelection;
  readonly map: SerializedFocusCameraSelection;
}

// 2台のカメラそれぞれの、進行直後の追従の材料。
export interface CameraFrameSamples {
  readonly combat: CameraFrameSample;
  readonly map: CameraFrameSample;
}

// マップのカメラの注視と距離を読む面。
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
  // 直前に追従した表示ビュー。マップから戦闘へ入る瞬間の補正にだけ使う。
  private followedView: ViewMode | null = null;

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
    const { combat, map } = serialized;
    const combatConfig = combatCameraConfig();
    const mapConfig = mapCameraConfig(celestialBodies.originId);
    return new CameraSelection(
      celestialBodies,
      events,
      combat === undefined ? undefined : FocusCameraSelection.deserialize(combat, celestialBodies, combatConfig, events),
      map === undefined ? undefined : FocusCameraSelection.deserialize(map, celestialBodies, mapConfig, events),
    );
  }

  // view が表に出ているときに使う1台。
  public camera(view: ViewMode): FocusCameraSelection {
    return view === 'map' ? this.map : this.combat;
  }

  // 進行の出来事と、その直後の姿勢・座標系へ視点を追従させる。通常は表示している view の
  // カメラだけを進めるが、操作対象の変更は次に戦闘ビューを開いた時にも反映できるよう戦闘
  // カメラの注視を役割へ戻す。マップから戦闘へ入るときも、前回の明示フォーカスを引き継がない。
  public followProgress(events: readonly RunEvent[], samples: CameraFrameSamples, view: ViewMode): void {
    if (this.followedView === 'map' && view === 'combat') {
      this.combat.setFocus({ kind: 'object', id: frameRoleAnchorId('controlled') });
    }
    this.followedView = view;
    let controlChanged = false;
    for (const { body } of events) {
      if (body.kind === 'controllableRemoved') this.map.clearFocusIf(body.id);
      if (body.kind === 'controlTargetSelected' || body.kind === 'controlTargetReleased') {
        controlChanged = true;
        this.combat.setFocus({ kind: 'object', id: frameRoleAnchorId('controlled') });
      }
    }
    // マップ表示中も、次に戦闘ビューへ戻った瞬間から新しい操作対象へ追従させる。
    if (controlChanged && view !== 'combat') this.combat.followProgress(samples.combat);
    this.camera(view).followProgress(view === 'map' ? samples.map : samples.combat);
  }

  // 2台分を直列化した形へ畳む。
  public serialize(): SerializedCameraSelection {
    return { combat: this.combat.serialize(), map: this.map.serialize() };
  }
}
