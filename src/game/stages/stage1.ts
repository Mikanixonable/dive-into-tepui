// Stage 1: 第一ステージ(LEO 戦域)。checkWin/onWin/hudSubStatus は基底クラスの既定
// (撃破数で勝利・HUD補助表示なし)のまま使う。
import * as C from '../const';
import { Stage } from './stage';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Player } from '../player/player';
import type { Simulator } from '../orbit-entity/simulator';
import { SimSpeedManager } from '../sim-speed-manager';

export class Stage1 extends Stage {
  readonly index = 1 as const;
  readonly selectLabel = '[1] 第一ステージ — LEO 戦域';
  readonly selectSub = '高度420kmの低軌道。敵5機はすべて近傍軌道に分布';
  readonly selectKeys = ['Digit1', 'Enter'];
  readonly initialAmmo = { magsLeft: C.INITIAL_MAGS - 1, roundsInMag: C.MAG_ROUNDS };

  briefingHtml(enemyCount: number): string {
    return (
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      '[Tab] ターゲット選択 → [F] ターゲット基準推進で接近 → [,/.] タイムワープで会合を短縮<br>' +
      '[H] キーで操作方法を表示'
    );
  }

  init(player: Player, simulator: Simulator): number {
    const base = player.state;
    const hud = this._hud;
    const sfx = this._sfx;
    const fx = this._fx;
    const scene = this._scene;
    this.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1400, 2, 0xff4a3d, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), simulator);
    this.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 2, 0xff7a2d, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), simulator);
    this.addEnemy(generateCrossingEnemy('HOSTILE-γ', base, 2200, 2, 0xe0409f, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), simulator);
    this.addEnemy(generateEllipticEnemy('HOSTILE-δ', base, 5000, 3, 0xbf3dff, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), simulator);
    this.addEnemy(generatePhasedEnemy('HOSTILE-ε', base, 60000, 3, 0xff2d6b, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), simulator);
    return 5;
  }
  update(dt: number, player: Player, simulator: Simulator, simTime: number, simSpeed: SimSpeedManager): void {    
    if (!this.isPlaying) return;
    
    this.behaveAllEnemies(dt, player, simulator, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player);
  }
}
