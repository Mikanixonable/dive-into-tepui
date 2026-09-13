import type { WorldSfx } from '../audio/sfx/world-sfx';
import { lenSq } from '../math/vec3';
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import { RCS_PUFF_TORQUE_EPS } from '../render/dynamic/player/rcs-effects';

// 操作対象1体の状態から、持続する推進音の宣言を毎フレーム組んで渡す。
// runInProgress が偽(一時停止中・勝敗確定後)なら、噴射指令が残っていても鳴らさない。
export function syncControlledLoopSfx(
  worldSfx: WorldSfx, controlled: Controllable | null, displayTime: number, runInProgress: boolean,
): void {
  const audible = controlled !== null
    && runInProgress
    && controlled.motion.alive
    && controlled.motion.stateAt(displayTime) !== null;
  worldSfx.syncLoops({
    thrust: audible && controlled.motion.thrust !== null,
    rcs: audible
      && lenSq(controlled.motion.torque) > RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS,
  });
}
