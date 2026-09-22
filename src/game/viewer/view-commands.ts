// ビュー選択へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { ViewMode } from '../view/view-mode';
import type { ViewSelection } from './view-selection';

// ビュー選択を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface ViewCommands {
  // view へ切り替える。
  select(view: ViewMode): void;
  // 戦闘/マップを切り替える。
  toggle(): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function viewCommands(queue: CommandQueue, selection: ViewSelection): ViewCommands {
  return {
    select: (view) => queue.submit(() => {
      selection.select(view);
    }),
    toggle: () => queue.submit(() => selection.toggle()),
  };
}
