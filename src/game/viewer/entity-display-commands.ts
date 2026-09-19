// 実体ごとの表示設定へ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { ProteinDisplaySettings } from '../../render/protein/protein-display';
import type { EntityDisplaySelection } from './entity-display-selection';

// 実体ごとの表示設定を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface EntityDisplayCommands {
  // id の実体の予測線・過去線を、出していれば消し、消していれば出す。
  toggleTrajectoryLine(id: string): void;
  // タンパク質の敵の表示形態と着色を display へ差し替える。
  setProteinDisplay(display: ProteinDisplaySettings): void;
}

// selection への命令を queue へ積むだけの口を組む。
export function entityDisplayCommands(
  queue: CommandQueue, selection: EntityDisplaySelection,
): EntityDisplayCommands {
  return {
    toggleTrajectoryLine: (id) => queue.submit(() => selection.toggleTrajectoryLine(id)),
    setProteinDisplay: (display) => queue.submit(() => selection.setProteinDisplay(display)),
  };
}
