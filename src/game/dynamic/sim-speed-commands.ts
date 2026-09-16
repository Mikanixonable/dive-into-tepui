// 時間加速へ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { SimSpeedManager } from './sim-speed-manager';

// 時間加速の段を外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface SimSpeedCommands {
  // 時間加速の倍率を speed へ差し替える。
  setSpeed(speed: number): void;
}

// manager への命令を queue へ積むだけの口を組む。
export function simSpeedCommands(queue: CommandQueue, manager: SimSpeedManager): SimSpeedCommands {
  return {
    setSpeed: (speed) => queue.submit(() => manager.setSpeed(speed)),
  };
}
