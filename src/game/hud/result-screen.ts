import { Sfx } from '../../audio/sfx';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ScoreCounter } from '../stages/stage-utils/score-counter';

// 終了画面(#hud-end)の表示。コンテナは hud/dom.ts が構築し、内容はここが直接操作する。
// title を渡すと見出しを差し替える(第零ステージのスコアアタック終了など、勝敗二択に収まらない結果画面向け)。
function showEnd(win: boolean, detailHtml: string, title?: string): void {
  const e = document.getElementById('hud-end');
  if (!e) return;
  e.className = win ? 'win' : 'lose';
  e.style.display = 'flex';
  e.style.pointerEvents = 'auto'; // タップでも再出撃できるようにする
  e.innerHTML = `
    <h1>${title ?? (win ? 'MISSION COMPLETE' : 'SHIP LOST')}</h1>
    <div class="detail">${detailHtml}</div>
    <div class="restart">[${K.restart.label}] キーまたはタップで再出撃</div>`;
  e.onclick = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: K.restart.code }));
}

// 終了画面表示の共通処理: BGM/推進音を止めてから結果画面を出す。
// 勝利(won/timeup)・敗北(lost)いずれの結末もこれを通す。
export function showResultScreen(sfx: Sfx, win: boolean, detailHtml: string, title?: string): void {
  sfx.setThrust(false);
  sfx.stopBgm();
  showEnd(win, detailHtml, title);
}

// 撃破数による勝利画面の文面(ステージ1/2で共通)。
export function showWinScreen(sfx: Sfx, scoreCounter: ScoreCounter, totalEnemies: number, simTime: number, title?: string): void {
  const { shots, hits } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  const detailHtml = (
    `全 ${totalEnemies} 機撃破<br>` +
    `ミッション時間 T+ ${Math.floor(simTime / 3600)}h ${Math.floor((simTime % 3600) / 60)}m ${Math.floor(simTime % 60)}s<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`
  );
  showResultScreen(sfx, true, detailHtml, title);
}

export function showScoreAttackResultScreen(sfx: Sfx, scoreCounter: ScoreCounter, title?: string): void {
  const { shots, hits, kills } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  const detailHtml =
    `撃墜数 ${kills} 機<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`;
  showResultScreen(sfx, true, detailHtml, title);
}
