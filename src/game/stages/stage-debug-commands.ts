// デバッグステージへ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { StageDebug } from './stage-debug';

// デバッグステージの状態を外から変える命令。どれも受け付けるだけで、適用は次の進行の位相。
export interface StageDebugCommands {
  // 敵の射撃の可否を切り替える。
  setEnemyFireEnabled(on: boolean): void;
  // 敵集団を1つ、自艦のまわりへ出す。
  spawnEnemyWave(): void;
  // 弾薬を1つ、自艦の近くへ出す。
  spawnAmmo(): void;
  // RCS燃料を1つ、自艦の近くへ出す。
  spawnRcsFuel(): void;
}

// stage への命令を queue へ積むだけの口を組む。
export function stageDebugCommands(queue: CommandQueue, stage: StageDebug): StageDebugCommands {
  return {
    setEnemyFireEnabled: (on) => queue.submit(() => stage.setEnemyFireEnabled(on)),
    spawnEnemyWave: () => queue.submit(() => stage.spawnEnemyWave()),
    spawnAmmo: () => queue.submit(() => stage.spawnAmmo()),
    spawnRcsFuel: () => queue.submit(() => stage.spawnRcsFuel()),
  };
}
