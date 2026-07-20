// Stage 1: 第一ステージ(LEO 戦域)。checkWin/onWin/hudSubStatus は基底クラスの既定
// (撃破数で勝利・HUD補助表示なし)のまま使う。
import * as C from '../const';
import { StageCtx, StageDefinition } from './stage-definition';
import {
  generateCoellipticEnemy,
  generateCrossingEnemy,
  generateEllipticEnemy,
  generatePhasedEnemy,
} from '../enemy/enemy-generator';

export class Stage1 extends StageDefinition {
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

  init(ctx: StageCtx): number {
    const base = ctx.player.state;
    const scene = ctx.scene;
    ctx.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1400, 2, 0xff4a3d, scene), 0x565b63);
    ctx.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2800, 2500, 2, 0xff7a2d, scene), 0x565b63);
    ctx.addEnemy(generateCrossingEnemy('HOSTILE-γ', base, 2200, 2, 0xe0409f, scene), 0x565b63);
    ctx.addEnemy(generateEllipticEnemy('HOSTILE-δ', base, 5000, 3, 0xbf3dff, scene), 0x565b63);
    ctx.addEnemy(generatePhasedEnemy('HOSTILE-ε', base, 60000, 3, 0xff2d6b, scene), 0x565b63);
    return 5;
  }

  update(_dt: number, ctx: StageCtx): void {
    this.ammoResupply.updateLogistics(ctx.simTime, ctx.player);
  }
}
