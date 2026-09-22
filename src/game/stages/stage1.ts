// Stage 1: 第一ステージ(LEO 戦域)。
import { Stage, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import { COLOR_ENEMY_ORBIT_LINE } from '../lines/entity-line-manager';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';

export class Stage1 extends Stage {
  public static readonly id = '1' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'stage 1';
  public static readonly selectSub = '【第一ステージ: LEO戦域】 高度420kmの低軌道。敵5機はすべて近傍軌道に分布';
  public static readonly selectKey = 'Digit1';

  // 自機と5機の敵を初期配置して始める。
  public static create(...deps: StageDeps): Stage1 {
    const stage = new Stage1(deps);
    // 自機を配置し、その運動状態を基準に敵機を近傍軌道へ分散配置する
    const player = stage.addPlayer();
    const referenceState = player.motion.state;
    const scene = stage._scene;
    const idAllocators = stage._dynamicSystem.idAllocators;
    const attractors = stage._celestialSystem.celestialMotions;
    stage.addEnemy(generatePhasedEnemy('HOSTILE-α', referenceState, attractors, 1400, 0xff4a3d, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generateCoellipticEnemy('HOSTILE-β', referenceState, attractors, -2800, 2500, 0xff7a2d, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generateCrossingEnemy('HOSTILE-γ', referenceState, attractors, 2200, 0xe0409f, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generateEllipticEnemy('HOSTILE-δ', referenceState, attractors, 5000, 0xbf3dff, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.addEnemy(generatePhasedEnemy('HOSTILE-ε', referenceState, attractors, 60000, 0xff2d6b, COLOR_ENEMY_ORBIT_LINE, scene, idAllocators));
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedStage | null, ...deps: StageDeps): Stage1 {
    return new Stage1(deps, ...Stage.deserializeCommonState(serialized, deps, Stage1.stageRules));
  }

  // 開始ブリーフィングの HTML を組み立てる。
  protected briefingHtml(): string {
    return (
      `<b>作戦目標: 敵機 ${this.enemiesAppeared} 機を全機撃破せよ</b><br>` +
      `敵を右クリックでターゲット固定 → 機首を向けて並進で接近 → [${K.warpSlower.label}]/[${K.warpFaster.label}] 時間加速で会合を短縮<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 1フレーム分、補給ロジスティクスを進める。
  public update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
