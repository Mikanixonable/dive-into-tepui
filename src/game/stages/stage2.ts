// Stage 2: 第二ステージ(モルニヤ戦域)。ステージ1クリアで解放。
import { Stage, type ClearCounts, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import {
  generateCoellipticEnemy,
  generateMolniyaEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import { COLOR_ENEMY_ORBIT_LINE } from '../lines/entity-line-manager';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';

export class Stage2 extends Stage {
  public static readonly id = '2' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'stage 2';
  public static readonly selectSub = '【第二ステージ: モルニヤ戦域】 敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モードでの遷移が必須';
  public static readonly selectLockedSub = '🔒 第一ステージをクリアすると解放';
  public static readonly selectKey = 'Digit2';

  // 自機を置き、通常軌道の敵とモルニヤ級軌道の敵を混成配置して始める。
  public static create(...deps: StageDeps): Stage2 {
    const stage = new Stage2(deps);
    const player = stage.addPlayer();
    const base = player.motion.state;
    const scene = stage._scene;
    const idAllocators = stage._dynamicSystem.idAllocators;
    const attractors = stage._celestialSystem.celestialMotions;
    // 通常軌道の敵
    stage.addEnemy(generatePhasedEnemy('HOSTILE-α', base, attractors, 1800, 0xff4a3d, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, attractors, -2600, 3000, 0xff7a2d, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    // モルニヤ級の高楕円軌道の敵
    stage.addEnemy(generateMolniyaEnemy('MOLNIYA-γ', base, attractors, 0.4, 2.6, 0xe0409f, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generateMolniyaEnemy('MOLNIYA-δ', base, attractors, 2.5, 0.9, 0xbf3dff, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generateMolniyaEnemy('MOLNIYA-ε', base, attractors, 4.6, 3.8, 0xff2d6b, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedStage | null, ...deps: StageDeps): Stage2 {
    return new Stage2(deps, ...Stage.deserializeCommonState(serialized, deps, Stage2.stageRules));
  }

  // 第一ステージのクリア実績があれば解放。
  public static isUnlocked(clearCounts: ClearCounts): boolean {
    return (clearCounts['1'] ?? 0) > 0;
  }

  // 作戦目標と操作方法を示すブリーフィング文面を組む。
  protected briefingHtml(): string {
    return (
      `<b>作戦目標: 敵機 ${this.enemiesAppeared} 機を全機撃破せよ</b><br>` +
      `敵の一部はモルニヤ級の高楕円軌道上にいる — [${K.toggleMapMode.label}] 軌道計画モードで遷移を計画せよ<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 補給品の湧きを進める。
  public update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
