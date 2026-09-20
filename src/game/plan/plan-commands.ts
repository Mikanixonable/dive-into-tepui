// 軌道計画へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Plan } from './plan';

// 計画の起点とノード列を外から変える命令。受け付けるだけで、適用は次の進行の位相。
// 対象は操作対象の艦とともに入れ替わるので、所有者そのものを引数で受ける。
export interface PlanCommands {
  // 噴射直後の絶対状態 postState をノードとして plan へ置く。from は、ノードが1件も無い計画の
  // 起点として凍結される状態。置ける実行時刻かどうかは Plan.nodeIndexFor で先に確かめる。
  addNode(plan: Plan, postState: KinematicState, from: KinematicState): void;
  // plan の idx 番目のノードを postState へ差し替え、下流ノードを破棄する。
  replaceNode(plan: Plan, idx: number, postState: KinematicState): void;
  // plan の idx 番目のノードを下流ノードごと削除する。
  removeNode(plan: Plan, idx: number): void;
  // plan のノードを全部削除する。
  clear(plan: Plan): void;
}

// 計画へのコマンドを queue へエンキューする実装を構築する。
export function planCommands(queue: CommandQueue): PlanCommands {
  return {
    addNode: (plan, postState, from) => queue.submit(() => { plan.addNode(postState, from); }),
    replaceNode: (plan, idx, postState) => queue.submit(() => plan.replaceNode(idx, postState)),
    removeNode: (plan, idx) => queue.submit(() => plan.removeNode(idx)),
    clear: (plan) => queue.submit(() => plan.clear()),
  };
}
