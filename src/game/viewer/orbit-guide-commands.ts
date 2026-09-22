// 軌道ガイドの選択へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { OrbitGuideSelection } from './orbit-guide-selection';
import type { OrbitGuideSettings } from './orbit-guide-settings';

// 軌道ガイドの選択を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface OrbitGuideCommands {
  // 軌道ガイドの設定を settings へ差し替える。
  setSettings(settings: OrbitGuideSettings): void;
}

// selection へのコマンドを queue へエンキューする実装を構築する。
export function orbitGuideCommands(queue: CommandQueue, selection: OrbitGuideSelection): OrbitGuideCommands {
  return {
    setSettings: (settings) => queue.submit(() => selection.setSettings(settings)),
  };
}
