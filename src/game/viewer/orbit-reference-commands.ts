// 軌道要素の基準の選択へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { OrbitReferenceMode, OrbitReferenceSelection } from './orbit-reference-selection';

// 軌道要素の基準の選択を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface OrbitReferenceCommands {
  // 基準の選び方を mode へ差し替える。
  setMode(mode: OrbitReferenceMode): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function orbitReferenceCommands(
  queue: CommandQueue, selection: OrbitReferenceSelection,
): OrbitReferenceCommands {
  return {
    setMode: (mode) => queue.submit(() => selection.setMode(mode)),
  };
}
