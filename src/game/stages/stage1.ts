// Stage 1: 第一ステージ(LEO 戦域)。checkWin/onWin/hudSubStatus は基底クラスの既定
// (撃破数で勝利・HUD補助表示なし)のまま使う。
import * as C from '../const';
import { StageCtx, Stage } from './stage';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Player } from '../player/player';
import type { Enemy } from '../orbit-entity/enemy';

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

  init(player: Player, addEnemy: (enemy: Enemy) => void): number {
    const base = player.state;
    const hud = this._hud;
    const sfx = this._sfx;
    const scene = this._scene;
    addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1400, 2, 0xff4a3d, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, scene));
    addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 2, 0xff7a2d, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, scene));
    addEnemy(generateCrossingEnemy('HOSTILE-γ', base, 2200, 2, 0xe0409f, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, scene));
    addEnemy(generateEllipticEnemy('HOSTILE-δ', base, 5000, 3, 0xbf3dff, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, scene));
    addEnemy(generatePhasedEnemy('HOSTILE-ε', base, 60000, 3, 0xff2d6b, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, scene));
    return 5;
  }

  update(_dt: number, ctx: StageCtx): void {
    this.logistics.updateLogistics(ctx.simTime, ctx.player);
  }
}
