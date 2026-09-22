// 航法ターゲットの選択へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { NavTargetSelection } from './nav-target-selection';

// 航法ターゲットを外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface NavTargetCommands {
  // id がいまのターゲットなら解除し、そうでなければ id を表示名 name でターゲットにする。
  toggle(id: string, name: string): void;
  // 戦闘対象 entity をターゲットにする。null ならターゲットを解除する。
  setCombatTarget(entity: CombatTarget | null): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function navTargetCommands(queue: CommandQueue, selection: NavTargetSelection): NavTargetCommands {
  return {
    toggle: (id, name) => queue.submit(() => selection.toggle(id, name)),
    setCombatTarget: (entity) => queue.submit(() => selection.setCombatTarget(entity)),
  };
}
