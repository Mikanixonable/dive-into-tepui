// 実体ごとの表示設定へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { EntityDisplaySelection } from './entity-display-selection';

// 実体ごとの表示設定を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface EntityDisplayCommands {
  // id の実体の予測線・過去線を、出していれば消し、消していれば出す。
  toggleTrajectoryLine(id: string): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function entityDisplayCommands(
  queue: CommandQueue, selection: EntityDisplaySelection,
): EntityDisplayCommands {
  return {
    toggleTrajectoryLine: (id) => queue.submit(() => selection.toggleTrajectoryLine(id)),
  };
}
