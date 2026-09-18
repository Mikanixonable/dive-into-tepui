// 接続中ブースターへ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { AttachedBoosters } from './attached-boosters';

// 接続中ブースターの段を外から足す・点火する・切り離す命令。受け付けるだけで、適用は次の
// 進行の位相。対象は操作対象の艦とともに入れ替わるので、所有者そのものを引数で受ける。
export interface BoosterCommands {
  // boosters の最後尾へ標準ブースターを1段足す。
  attach(boosters: AttachedBoosters): void;
  // boosters の最後尾段の点火を反転する。
  toggleIgnition(boosters: AttachedBoosters): void;
  // boosters の最後尾段を分離し、独立エンティティとして顔ぶれへ入れる。
  decouple(boosters: AttachedBoosters): void;
}

// ブースターへの命令を queue へ積むだけの口を組む。
export function boosterCommands(queue: CommandQueue): BoosterCommands {
  return {
    attach: (boosters) => queue.submit(() => boosters.attach()),
    toggleIgnition: (boosters) => queue.submit(() => boosters.toggleIgnition()),
    decouple: (boosters) => queue.submit(() => boosters.decouple()),
  };
}
