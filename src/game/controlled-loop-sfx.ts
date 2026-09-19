import { lenSq } from '../math/vec3';
import { RCS_PUFF_TORQUE_EPS } from '../render/dynamic/player/rcs-effects';
import type { LoopSfx } from '../audio/sfx/world-sfx';
import type { Controllable } from './dynamic/dynamic-entity/controllable';

// 操作対象1体の状態から組む、持続する推進音の宣言。runInProgress が偽(一時停止中・勝敗確定後)なら、
// 噴射指令が残っていても鳴らさない。
export function controlledLoopSfx(
  controlled: Controllable | null, displayTime: number, runInProgress: boolean,
): LoopSfx {
  const audible = controlled !== null
    && runInProgress
    && controlled.motion.alive
    && controlled.motion.stateAt(displayTime) !== null;
  return {
    thrust: audible && controlled.motion.thrust !== null,
    rcs: audible
      && lenSq(controlled.motion.torque) > RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS,
  };
}
