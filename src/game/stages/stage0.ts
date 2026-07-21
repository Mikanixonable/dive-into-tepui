// Stage 0: 訓練ステージ。近傍の色分けクラスタを制限時間内に何機撃墜できるかのスコアアタック
// (タイムアップで終わる。撃破数では終わらないので checkWin/onWin は no-op に override する)。
import * as C from '../const';
import { StageCtx, Stage } from './stage';
import { showScoreAttackResultScreen } from '../result-screen';
import { generateCluster } from './spawner/enemy-spawner';
import { ScoreAttackTimer } from './stage-utils/score-attack-timer';
import type { Player } from '../player/player';
import type { Enemy } from '../orbit-entity/enemy';

export class Stage0 extends Stage {
  readonly index = 0 as const;
  readonly selectLabel = '[T] 訓練ステージ — 近接戦闘訓練 (Stage 0)';
  readonly selectSub = '常時選択可。5km以内に色分けされた敵集団 約50機、制限時間2分の撃墜数スコアアタック';
  readonly selectKeys = ['KeyT'];
  readonly initialAmmo = { magsLeft: 0, roundsInMag: 0 };

  private readonly timer = new ScoreAttackTimer(C.STAGE0_TIME_LIMIT);

  briefingHtml(): string {
    return (
      `<b>訓練ステージ: 制限時間 ${Math.floor(C.STAGE0_TIME_LIMIT / 60)}分で何機撃墜できるか</b><br>` +
      '周囲5km以内の色分けされた集団を撃墜せよ — RCS並進(WSADQE)と回転(IKJLUO)の練習に最適<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      '[H] キーで操作方法を表示'
    );
  }

  init(player: Player, addEnemy: (enemy: Enemy) => void): number {
    for (let i = 0; i < C.STAGE0_LOGISTICS_INITIAL_AMMO; i++) {
      this.logistics.spawnForPlayer(player, C.STAGE0_LOGISTICS_MIN_DIST, C.STAGE0_LOGISTICS_MAX_DIST);
    }
    const enemies = generateCluster(player.state, this._hud, this._sfx, this._fx, this._scene);
    for (const enemy of enemies) addEnemy(enemy);
    return enemies.length;
  }

  update(dt: number, ctx: StageCtx): void {
    this.logistics.updateLogistics(ctx.simTime, ctx.player);
    if (this.timer.update(dt, this._setPhase)) {
      showScoreAttackResultScreen(this._hud, this._sfx, this.scoreCounter, 'TIME UP');
    }
  }

  checkWin(): boolean { return false; } // 終了は update 内のタイムアップ判定
  onWin(): void { /* no-op: このステージは撃破数では終わらない */ }

  hudSubStatus(): string {
    return `残り時間: ${Math.ceil(this.timer.timeLeft)}秒`;
  }
}
