// Stage 1: 第一ステージ(LEO 戦域)。
import * as C from '../const';
import { Stage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Vessel } from '../vessel/vessel';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';
import type { StageSaveData } from '../save-data';

export class Stage1 extends Stage {
  static readonly id = '1' as const;
  static readonly selectLabel = 'stage 1';
  static readonly selectSub = '【第一ステージ: LEO戦域】 高度420kmの低軌道。敵5機はすべて近傍軌道に分布';
  static readonly selectKeys = ['Digit1', 'Enter'];

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.begin();
  }

  // 開始ブリーフィングの HTML を組み立てる。
  briefingHtml(): string {
    return (
      `<b>作戦目標: 敵機 ${this.scoreCounter.totalEnemiesSpawned} 機を全機撃破せよ</b><br>` +
      `敵を右クリックでターゲット固定 → 機首を向けて並進で接近 → [${K.warpSlower.label}]/[${K.warpFaster.label}] 時間加速で会合を短縮<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 自機と5機の敵を初期配置する。
  protected init(entities: EntityManager): void {
    const player = this.addOwnShip();
    const base = player.state;
    // 各種軌道パターンの敵を配置する
    this.addHostile(generatePhasedEnemy('HOSTILE-α', base, 1400, 0xff4a3d, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 0xff7a2d, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generateCrossingEnemy('HOSTILE-γ', base, 2200, 0xe0409f, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generateEllipticEnemy('HOSTILE-δ', base, 5000, 0xbf3dff, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
    this.addHostile(generatePhasedEnemy('HOSTILE-ε', base, 60000, 0xff2d6b, C.COLOR_ENEMY_ORBIT_LINE, this.vesselDeps), entities);
  }
  // 1フレーム分、敵の行動と補給ロジスティクスを進める。
  update(dt: number, player: Vessel | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;

    this.behaveAllHostiles(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
