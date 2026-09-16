// Stage 1: 第一ステージ(LEO 戦域)。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { StageSaveData } from '../save/save-data';
import { COLOR_ENEMY_ORBIT_LINE } from '../lines/entity-line-manager';

export class Stage1 extends Stage {
  static readonly id = '1' as const;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'stage 1';
  static readonly selectSub = '【第一ステージ: LEO戦域】 高度420kmの低軌道。敵5機はすべて近傍軌道に分布';
  static readonly selectKey = 'Digit1';

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
  protected init(): void {
    const player = this.addPlayer();
    const base = player.motion.state;
    const fx = this._fx;
    const scene = this._scene;
    const idAllocators = this._dynamicSystem.idAllocators;
    const attractors = this._celestialSystem.celestialMotions;
    this.addEnemy(generatePhasedEnemy('HOSTILE-α', base, attractors, 1400, 0xff4a3d, COLOR_ENEMY_ORBIT_LINE, fx, scene, idAllocators));
    this.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, attractors, -2800, 2500, 0xff7a2d, COLOR_ENEMY_ORBIT_LINE, fx, scene, idAllocators));
    this.addEnemy(generateCrossingEnemy('HOSTILE-γ', base, attractors, 2200, 0xe0409f, COLOR_ENEMY_ORBIT_LINE, fx, scene, idAllocators));
    this.addEnemy(generateEllipticEnemy('HOSTILE-δ', base, attractors, 5000, 0xbf3dff, COLOR_ENEMY_ORBIT_LINE, fx, scene, idAllocators));
    this.addEnemy(generatePhasedEnemy('HOSTILE-ε', base, attractors, 60000, 0xff2d6b, COLOR_ENEMY_ORBIT_LINE, fx, scene, idAllocators));
  }
  // 1フレーム分、補給ロジスティクスを進める。
  update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
