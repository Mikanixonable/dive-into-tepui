// Stage 1: 第一ステージ(LEO 戦域)。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Player } from '../player/player';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { StageSaveData } from '../save/save-data';
import { COLOR_ENEMY_ORBIT_LINE } from '../lines/entity-line-manager';

export class Stage1 extends Stage {
  static readonly id = '1' as const;
  static readonly epoch = STORY_EPOCH;
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
  protected init(entities: DynamicSystem): void {
    const player = this.addPlayer();
    const base = player.state;
    const worldSfx = this._worldSfx;
    const fx = this._fx;
    const scene = this._scene;
    // 各種軌道パターンの敵を配置する
    this.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1400, 0xff4a3d, COLOR_ENEMY_ORBIT_LINE, worldSfx, fx, scene), entities);
    this.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 0xff7a2d, COLOR_ENEMY_ORBIT_LINE, worldSfx, fx, scene), entities);
    this.addEnemy(generateCrossingEnemy('HOSTILE-γ', base, 2200, 0xe0409f, COLOR_ENEMY_ORBIT_LINE, worldSfx, fx, scene), entities);
    this.addEnemy(generateEllipticEnemy('HOSTILE-δ', base, 5000, 0xbf3dff, COLOR_ENEMY_ORBIT_LINE, worldSfx, fx, scene), entities);
    this.addEnemy(generatePhasedEnemy('HOSTILE-ε', base, 60000, 0xff2d6b, COLOR_ENEMY_ORBIT_LINE, worldSfx, fx, scene), entities);
  }
  // 1フレーム分、敵の行動と補給ロジスティクスを進める。
  update(_dt: number, player: Player | null, entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;

    this.behaveAllEnemies(player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
