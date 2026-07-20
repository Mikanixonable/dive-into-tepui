// 敵の撃破・喪失の集計と勝敗判定。
// 弾の発射・衝突判定・敵 AI・エフェクトのスポーンは、それぞれ player-fire.ts /
// combat/hit.ts / enemy.ts の Enemy.behave / effects-system.ts へ切り出し済み。
// game.ts を import しない — 依存は CombatCtx 引数・コンストラクタ注入のみ。
import * as C from '../const';
import { Ship } from '../entities';
import { Player } from '../player/player';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { ACCENT } from '../theme';
import { EffectsCtx } from '../effects-system';

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
  ) {}

  recordShot(): void {
    this.shots++;
  }

  recordHit(): void {
    this.hits++;
  }

  /**
   * 撃破の集計・勝敗判定のみを行う(エフェクト・SFX・alive 遷移は Ship.destroyEffect の責務)。
   * @param byPlayer true = 弾丸命中による正式撃破(kills に加算し勝利判定を行う)
   *                 false = 再突入・空力分解など物理的消滅(カウントせず静かに除去)
   */
  destroyShip(ship: Ship, ctx: CombatCtx, byPlayer = true): void {
    ship.destroyEffect({ sfx: this.sfx, fx: ctx.fx });

    if (ship === ctx.player) {
      ctx.setPhase('lost');
      this.sfx.setThrust(false);
      this.sfx.stopBgm();
      this.hud.showEnd(false, `${ctx.lostReason}<br>撃破 ${this.kills}/${ctx.totalEnemies} 機`);
      return;
    }

    if (byPlayer) {
      // 弾丸命中による正式撃破のみカウント
      this.kills++;
      this.hud.hint(`${ship.name} 撃破`);
    } else {
      // 再突入・空力分解によるデスポーンは撃破に含めない
      this.losses++;
      this.hud.hint(`${ship.name} 再突入により喪失`);
    }

    // 残存数は destroyShip 呼び出しの集計(kills/losses)だけで求める — enemies 配列は
    // 撃破された個体から prune されて縮むため、勝敗判定にその配列の中身は見ない。
    const remaining = ctx.totalEnemies - this.kills - this.losses;
    // ステージ00(無限サバイバル)とステージ0(時間制限スコアアタック)は、敵全滅でクリアにはならない
    if (ctx.stage === 0 || ctx.stage === -1 || remaining > 0) return;
    // 再突入等で全機消滅しても勝利にはしない(byPlayer=false は無視する) —
    // 残存機ゼロだが kills < totalEnemies のまま、プレイングは継続させる。
    if (!byPlayer) return;

    ctx.setPhase('won');
    this.sfx.setThrust(false);
    this.sfx.stopBgm();
    let unlockNote = '';
    if (ctx.stage === 1) {
      try {
        const first = localStorage.getItem(C.STAGE1_CLEARED_KEY) !== '1';
        localStorage.setItem(C.STAGE1_CLEARED_KEY, '1');
        if (first) unlockNote = `<br><span style="color:${ACCENT}">第二ステージ(モルニヤ戦域)が解放された</span>`;
      } catch {
        /* localStorage 不可なら解放なし */
      }
    }
    const acc = this.shots > 0 ? ((this.hits / this.shots) * 100).toFixed(1) : '0.0';
    this.hud.showEnd(
      true,
      `全 ${ctx.totalEnemies} 機撃破<br>` +
        `ミッション時間 T+ ${Math.floor(ctx.simTime / 3600)}h ${Math.floor((ctx.simTime % 3600) / 60)}m ${Math.floor(ctx.simTime % 60)}s<br>` +
        `発射 ${this.shots} 発 / 命中 ${this.hits} 発 (命中率 ${acc}%)` +
        unlockNote,
    );
  }
}
