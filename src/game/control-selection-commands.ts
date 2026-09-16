// 操作対象の選択へ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from './command-queue';
import type { ControlSelection } from './control-selection';
import type { Controllable } from './dynamic/dynamic-entity/controllable';

// 操作対象の選択を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface ControlSelectionCommands {
  // 操作対象を target へ差し替える。
  select(target: Controllable): void;
}

// selection への命令を queue へ積むだけの口を組む。
export function controlSelectionCommands(
  queue: CommandQueue, selection: ControlSelection,
): ControlSelectionCommands {
  return {
    select: (target) => queue.submit(() => selection.select(target)),
  };
}
