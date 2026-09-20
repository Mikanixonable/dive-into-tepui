// 自機の展開物(太陽電池・放熱板)へ外部から発行できるコマンドインターフェースと、それをキューへエンキューする実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { PowerSystem, SolarSide } from './power';
import type { RadiatorSide, RadiatorSystem } from './radiator';

// 展開物の展開/収納を外から切り替える命令。受け付けるだけで、適用は次の進行の位相。
// 対象は操作対象の艦とともに入れ替わるので、所有者そのものを引数で受ける。
export interface DeployableCommands {
  // power の side のパネルの展開/収納を反転する。
  toggleSolar(power: PowerSystem, side: SolarSide): void;
  // radiator の side のパネルの展開/収納を反転する。
  toggleRadiator(radiator: RadiatorSystem, side: RadiatorSide): void;
}

// 展開物へのコマンドを queue へエンキューする実装を構築する。
export function deployableCommands(queue: CommandQueue): DeployableCommands {
  return {
    toggleSolar: (power, side) => queue.submit(() => power.toggle(side)),
    toggleRadiator: (radiator, side) => queue.submit(() => radiator.toggle(side)),
  };
}
