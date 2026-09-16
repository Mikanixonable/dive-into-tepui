// 時間加速へ外から出せる命令の口と、それを列へ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { KinematicState } from '../../physics/kinematic-state';
import type { SimSpeedManager } from './sim-speed-manager';

// 時間加速の段と自動ワープを外から変える命令。受け付けるだけで、適用は次の進行の位相。
export interface SimSpeedCommands {
  // 時間加速の倍率を speed へ差し替える。
  setSpeed(speed: number): void;
  // 単発入力 commandId に対応する段の上げ下げを行う。
  handleCommand(commandId: string): void;
  // simTime を現在時刻として、時刻 time までの自動ワープを始める。目指せる時刻かどうかは
  // SimSpeedManager.canAutoWarpTo で先に確かめる。
  startAutoWarpTo(time: number, simTime: number): void;
  // 進行中の自動ワープを解除する。
  cancelAutoWarp(): void;
  // firstNode の実行時刻までの自動ワープをトグルする。ノードが無ければ計画を促す。
  toggleAutoWarpToFirstNode(firstNode: KinematicState | undefined, simTime: number): void;
}

// manager への命令を queue へ積むだけの口を組む。
export function simSpeedCommands(queue: CommandQueue, manager: SimSpeedManager): SimSpeedCommands {
  return {
    setSpeed: (speed) => queue.submit(() => manager.setSpeed(speed)),
    handleCommand: (commandId) => queue.submit(() => manager.handleCommand(commandId)),
    startAutoWarpTo: (time, simTime) => queue.submit(() => { manager.startAutoWarpTo(time, simTime); }),
    cancelAutoWarp: () => queue.submit(() => manager.cancelAutoWarp()),
    toggleAutoWarpToFirstNode: (firstNode, simTime) => queue.submit(
      () => manager.toggleAutoWarpToFirstNode(firstNode, simTime)),
  };
}
