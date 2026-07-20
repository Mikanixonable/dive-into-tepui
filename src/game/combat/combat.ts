// 敵の撃破・喪失の集計と勝敗判定。
// 弾の発射・衝突判定・敵 AI・エフェクトのスポーンは、それぞれ player-fire.ts /
// combat/hit.ts / enemy.ts の Enemy.behave / effects-system.ts へ切り出し済み。
// ステージごとの勝利条件・勝利画面は stage-data.ts の StageDefinition が持つ(ここでは
// 撃破/喪失の集計のみ行い、ステージ番号による分岐は一切しない)。
// game.ts を import しない — 依存は CombatCtx 引数・コンストラクタ注入のみ。
import { Ship as Enemy } from '../entities';
import { Player } from '../player/player';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { EffectsCtx } from '../effects-system';
import { getStageDefinition, StageWinCtx } from '../stage-data';
import { showResultScreen } from '../result-screen';
import { UnlockManager } from '../unlock-manager';

// destroyShip が必要とする、Game 側の現在状態のスナップショット。
// fx はエフェクトのスポーンに必要な最小の受け皿(effects-system.ts の EffectsCtx)。
export interface CombatCtx {
  simTime: number;
  player: Player;
  totalEnemies: number;
  stage: number;
  lostReason: string;
  setLostReason(reason: string): void;
  setPhase(phase: 'playing' | 'won' | 'lost' | 'timeup'): void;
  sfx: Sfx;
  fx: EffectsCtx;
}

export class CombatSystem {
  shots = 0;
  hits = 0;
  kills = 0;
  // 非プレイヤー起因の喪失数(再突入・空力分解等)。勝利判定の残存数計算にのみ使う。
  private losses = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    private readonly unlockManager: UnlockManager,
  ) { }

  recordShot(): void {
    this.shots++;
  }

  recordHit(): void {
    this.hits++;
  }

  // reason 省略時は被弾(attacked)の2択文言を byPlayer から決める。
  // 自然死(checkLoss)は原因ごとに異なる文言を持つため reason で明示的に渡す。
  recordKilled(ctx: CombatCtx, reason: string): void {
    ctx.setLostReason(reason);
    ctx.setPhase('lost');
    showResultScreen(this.hud, this.sfx, false, `${ctx.lostReason}<br>撃破 ${this.kills}/${ctx.totalEnemies} 機`);
  }

  /**
   * 撃破の集計と、ステージの勝利条件判定への橋渡しを行う(alive 遷移・撃破エフェクトは
   * 呼び出し元の Ship.attacked/checkLoss が既に済ませている — ここでは呼ばない)。
   * @param byPlayer true = 弾丸命中による正式撃破(kills に加算し勝利判定を行う)
   *                 false = 再突入・空力分解など物理的消滅(カウントせず静かに除去)
   */
  recordKill(enemy: Enemy, ctx: CombatCtx, byPlayer = true): void {
    if (!byPlayer) {
      // 再突入・空力分解によるデスポーンは撃破に含めない。勝利判定は losses を
      // 差し引くためだけに使い、この経路自体は勝利判定を起動しない
      // (全機が再突入で消滅しても、それだけでは勝利にならない)。
      this.losses++;
      this.hud.hint(`${enemy.name} 再突入により喪失`);
      return;
    }
    this.kills++;
    this.hud.hint(`${enemy.name} 撃破`);

    const stageDef = getStageDefinition(ctx.stage);
    const winCtx: StageWinCtx = {
      kills: this.kills,
      losses: this.losses,
      totalEnemies: ctx.totalEnemies,
      shots: this.shots,
      hits: this.hits,
      simTime: ctx.simTime,
    };
    
    if (stageDef.checkWin(winCtx)) {
      ctx.setPhase('won');
      this.unlockManager.reportClear(ctx.stage, this.hud);
      stageDef.onWin(winCtx, this.hud, this.sfx);
    }
  }
}
