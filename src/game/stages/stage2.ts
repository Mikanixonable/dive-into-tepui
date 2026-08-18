// Stage 2: 第二ステージ(モルニヤ戦域)。ステージ1クリアで解放。
import * as C from '../const';
import { Stage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { ClearCounts } from '../unlock-manager';
import {
  generateCoellipticEnemy,
  generateMolniyaEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Vessel } from '../vessel/vessel';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';
import type { StageSaveData } from '../save-data';

export class Stage2 extends Stage {
  static readonly id = '2' as const;
  static readonly selectLabel = 'stage 2';
  static readonly selectSub = '【第二ステージ: モルニヤ戦域】 敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モードでの遷移が必須';
  static readonly selectLockedSub = '🔒 第一ステージをクリアすると解放';
  static readonly selectKeys = ['Digit2'];

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.begin();
  }

  // 第一ステージのクリア実績があれば解放。
  static isUnlocked(clearCounts: ClearCounts): boolean {
    return (clearCounts['1'] ?? 0) > 0;
  }

  // 作戦目標と操作方法を示すブリーフィング文面を組む。
  briefingHtml(): string {
    return (
      `<b>作戦目標: 敵機 ${this.scoreCounter.totalEnemiesSpawned} 機を全機撃破せよ</b><br>` +
      `敵の一部はモルニヤ級の高楕円軌道上にいる — [${K.toggleMapMode.label}] 軌道計画モードで遷移を計画せよ<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 自機を置き、通常軌道の敵とモルニヤ級軌道の敵を混成配置する。
  protected init(entities: EntityManager): void {
    const player = this.addOwnShip();
    const base = player.state;
    // 通常軌道の敵
    this.addHostile(generatePhasedEnemy('HOSTILE-α', base, 1800, 2, 0xff4a3d, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generateCoellipticEnemy('HOSTILE-β', base, -2600, 3000, 2, 0xff7a2d, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    // モルニヤ級の高楕円軌道の敵
    this.addHostile(generateMolniyaEnemy('MOLNIYA-γ', base.t, 0.4, 2.6, 3, 0xe0409f, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generateMolniyaEnemy('MOLNIYA-δ', base.t, 2.5, 0.9, 3, 0xbf3dff, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generateMolniyaEnemy('MOLNIYA-ε', base.t, 4.6, 3.8, 3, 0xff2d6b, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
  }
  // 敵の行動と補給品の湧きを進める。
  update(dt: number, player: Vessel | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;

    this.behaveAllHostiles(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
