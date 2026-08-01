// クリエイティブモード: 勝敗判定を発生させず、艦艇配置と軌道計画を自由に試すためのステージ。
import { Stage } from './stage';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import type { SimSpeedManager } from '../sim-speed-manager';

export class CreativeStage extends Stage {
  static readonly id = 'creative' as const;
  readonly selectLabel = 'CREATIVE';
  readonly selectSub = '軌道上に艦艇を自由に配置して眺める';
  readonly hiddenFromSelect = true;
  readonly selectKeys: string[] = [];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  briefingHtml(): string {
    return '<b>クリエイティブモード</b><br>マップから艦艇を配置して軌道を眺められる。';
  }

  init(_player: Player, _entities: EntityManager): number {
    return 0;
  }

  update(_dt: number, _player: Player, _entities: EntityManager, _simTime: number, _simSpeed: SimSpeedManager): void {
  }

  checkWin(): boolean {
    return false;
  }
}
