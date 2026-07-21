import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { StageWinCtx } from './stages/stage';
import { ScoreCounter } from './stages/stage-utils/score-counter';

// 終了画面表示の共通処理: BGM/推進音を止めてから HUD の結果画面を出す。
// 勝利(won/timeup)・敗北(lost)いずれの結末もこれを通す。
export function showResultScreen(hud: Hud, sfx: Sfx, win: boolean, detailHtml: string, title?: string): void {
  sfx.setThrust(false);
  sfx.stopBgm();
  hud.showEnd(win, detailHtml, title);
}

// 撃破数による勝利画面の文面(ステージ1/2で共通)。
export function showWinScreen(hud: Hud, sfx: Sfx, ctx: StageWinCtx, title?: string): void {
  const { shots, hits } = ctx.scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  const detailHtml = (
    `全 ${ctx.totalEnemies} 機撃破<br>` +
    `ミッション時間 T+ ${Math.floor(ctx.simTime / 3600)}h ${Math.floor((ctx.simTime % 3600) / 60)}m ${Math.floor(ctx.simTime % 60)}s<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`
  );
  showResultScreen(hud, sfx, true, detailHtml, title);
}

export function showScoreAttackResultScreen(hud: Hud, sfx: Sfx, scoreCounter: ScoreCounter, title?: string): void {
  const { shots, hits, kills } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  const detailHtml =
    `撃墜数 ${kills} 機<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`;
  showResultScreen(hud, sfx, true, detailHtml, title);
}
