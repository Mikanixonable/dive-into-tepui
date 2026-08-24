import type { Base } from '../../game-entity/base';
import type { Player } from '../../player/player';

// 各タブコントローラが BasePanel の共有状態を読み書きするための窓口。
export interface BasePanelContext {
  base(): Base;
  freeProcurement(): boolean;
  vessel(): Player | null;
  selectVessel(vessel: Player | null): void;
  switchToPartsTab(): void;
  refresh(): void;
  notifyLaunch(ship: Player, base: Base): void;
  notifyBuildVessel(base: Base): void;
}
