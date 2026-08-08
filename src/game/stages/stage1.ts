// Stage 1: 第一ステージ(LEO 戦域)。
import * as C from '../const';
import { Stage } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';

export class Stage1 extends Stage {
  static readonly id = '1' as const;
  readonly selectLabel = 'stage 1';
  readonly selectSub = '【第一ステージ: LEO戦域】 高度420kmの低軌道。敵5機はすべて近傍軌道に分布';
  readonly selectKeys = ['Digit1', 'Enter'];
  readonly initialAmmo = { mags: C.INITIAL_MAGS - 1, rounds: C.MAG_ROUNDS };

  // 開始ブリーフィングの HTML を組み立てる。
  briefingHtml(enemyCount: number): string {
    return (
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      `敵を右クリックでターゲット固定 → 機首を向けて並進で接近 → [${K.warpSlower.label}]/[${K.warpFaster.label}] 時間加速で会合を短縮<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 5機の敵を初期配置し、敵数を返す。
  init(player: Player, entities: EntityManager): number {
    const base = player.state;
    const hud = this._hud;
    const sfx = this._sfx;
    const fx = this._fx;
    const scene = this._scene;
    // 各種軌道パターンの敵を配置する
    this.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1400, 2, 0xff4a3d, C.COLOR_ENEMY_ORBIT_LINE, hud, sfx, fx, scene), entities);
    this.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 2, 0xff7a2d, C.COLOR_ENEMY_ORBIT_LINE, hud, sfx, fx, scene), entities);
    this.addEnemy(generateCrossingEnemy('HOSTILE-γ', base, 2200, 2, 0xe0409f, C.COLOR_ENEMY_ORBIT_LINE, hud, sfx, fx, scene), entities);
    this.addEnemy(generateEllipticEnemy('HOSTILE-δ', base, 5000, 3, 0xbf3dff, C.COLOR_ENEMY_ORBIT_LINE, hud, sfx, fx, scene), entities);
    this.addEnemy(generatePhasedEnemy('HOSTILE-ε', base, 60000, 3, 0xff2d6b, C.COLOR_ENEMY_ORBIT_LINE, hud, sfx, fx, scene), entities);
    return 5;
  }
  // 1フレーム分、敵の行動と補給ロジスティクスを進める。
  update(dt: number, player: Player | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying || !player) return;

    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player, simSpeed);
  }
}
