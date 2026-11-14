// ストーリーの所要時間つき作業(建造・修理)の進行。状態は船の建造予約とドック
// 状態が持ち、ここは完了時刻の来た作業を適用するだけである(GAME.md 11.4)。
// ストーリーのステージが毎フレーム、全ての船について呼ぶ。
import {
  ShipConstructionEdits, type ConstructionShip,
} from '../ship/ship-construction-edits';
import type { StoryEconomy } from './story-economy';

// 作業の進行が船に求める面。建造の編集対象に、修理の適用先が加わる。
export interface StoryWorkShip extends ConstructionShip {
  repairAtDock(moduleId: string): void;
}

// 完了時刻の来た作業を船1隻ぶん適用する。
export function advanceShipWorks(
  ship: StoryWorkShip, simTime: number, economy: StoryEconomy | null,
): void {
  // 建造の完了。完了時刻が来ていなければ、または配置ができなくなっていれば、
  // 部品は建造中のまま残る。
  for (const draft of ship.docks.serialize()) {
    if (draft.pendingModule === null) continue;
    // 完了に支払いは伴わない(素材は着手時に支払い済み)。
    new ShipConstructionEdits(ship, draft.dockId).completePending(simTime);
  }
  // 修理の完了。完了時点で修理の条件(ドックが健全で接続が続いていること)を
  // 失っていれば、修理は行われず、着手時に支払った素材は備蓄へ戻る。
  for (const repair of ship.docks.dueRepairs(simTime)) {
    try {
      ship.repairAtDock(repair.dockId);
    } catch {
      economy?.refund(ship.id, repair.materials, 0);
    }
  }
}
