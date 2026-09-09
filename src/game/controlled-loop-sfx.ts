import type { WorldSfx } from '../audio/sfx/world-sfx';
import { lenSq } from '../math/vec3';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { MapVisibilityPolicy } from './map/visibility-policy';
import { RCS_PUFF_TORQUE_EPS } from './player/rcs-effects';

// 操作対象1体の表示状態から、持続する推進音を毎フレーム同期する。
export function syncControlledLoopSfx(
  worldSfx: WorldSfx, controlled: Controllable | null, displayTime: number,
  visibilityPolicy: MapVisibilityPolicy | null,
): void {
  const visible = controlled !== null
    && controlled.motion.alive
    && controlled.motion.stateAt(displayTime) !== null
    && (visibilityPolicy?.entity(controlled.mapKind, true).category ?? true);
  worldSfx.setThrust(visible && controlled.motion.thrust !== null);
  worldSfx.setRcs(visible
    && lenSq(controlled.motion.torque) > RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS);
}
