import { Sfx } from '../../audio/sfx';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { ScoreCounter } from '../stages/stage-utils/score-counter';
import { FONT_L, SPACE_6, TEXT_DIM } from '../theme';
import type { Hud } from './hud';
import type { OverlayHandle } from './overlay-manager';

// 結果画面(#hud-end)そのものの OverlayManager 登録先。閉じる手段は再出撃/タイトルへの
// 遷移(いずれもページ離脱かリロードで表現される)のみなので、ESC・外側クリックでは閉じない
// — 登録するのは入力ゲート(タッチパッドの解放・背景入力の遮断)のためだけ。
const resultScreenOverlay: OverlayHandle = {
  contains: (target) => document.getElementById('hud-end')?.contains(target) ?? false,
  close: () => {},
};

// title を渡すと見出しを差し替える(勝敗二択に収まらない結果画面向け)。
function showEnd(hud: Hud, win: boolean, detailHtml: string, title?: string): void {
  const e = document.getElementById('hud-end');
  if (!e) return;
  // 勝敗に応じたスタイルで表示する
  e.className = win ? 'win' : 'lose';
  e.style.display = 'flex';
  e.style.pointerEvents = 'auto';
  e.innerHTML = `
    <h1>${title ?? (win ? 'MISSION COMPLETE' : 'SHIP LOST')}</h1>
    <div class="detail">${detailHtml}</div>
    <div class="restart" style="cursor: pointer;">[${K.restart.label}] キーまたはタップで再出撃</div>
    <div class="title-return" style="margin-top: ${SPACE_6}; color: ${TEXT_DIM}; font-size: ${FONT_L}; cursor: pointer; text-decoration: underline;">タイトル画面に戻る</div>`;
  // クリック/タップを各ボタンのアクションとして扱う
  e.querySelector('.restart')!.addEventListener('click', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: K.restart.code }));
  });
  e.querySelector('.title-return')!.addEventListener('click', () => {
    location.href = location.pathname; // URLパラメータなしのパスへ遷移
  });
  hud.overlayManager.open('result', resultScreenOverlay, {
    kind: 'modal', closeOnEscape: false, closeOnOutsideClick: false, gatesInput: true,
  });
}

// エンジン音・BGM を止めた上で結果画面を表示する。
export function showResultScreen(hud: Hud, sfx: Sfx, win: boolean, detailHtml: string, title?: string): void {
  sfx.setThrust(false);
  sfx.stopBgm();
  showEnd(hud, win, detailHtml, title);
}

// 撃破数・所要時間・命中率をまとめた勝利画面を表示する。
export function showWinScreen(
  hud: Hud, sfx: Sfx, scoreCounter: ScoreCounter, totalEnemies: number, simTime: number, title?: string,
): void {
  const { shots, hits } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  const detailHtml = (
    `全 ${totalEnemies} 機撃破<br>` +
    `ミッション時間 T+ ${Math.floor(simTime / 3600)}h ${Math.floor((simTime % 3600) / 60)}m ${Math.floor(simTime % 60)}s<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`
  );
  showResultScreen(hud, sfx, true, detailHtml, title);
}

// 撃墜数・命中率をまとめたスコアアタック結果画面を表示する。
export function showScoreAttackResultScreen(hud: Hud, sfx: Sfx, scoreCounter: ScoreCounter, title?: string): void {
  const { shots, hits, kills } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  const detailHtml =
    `撃墜数 ${kills} 機<br>` +
    `発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`;
  showResultScreen(hud, sfx, true, detailHtml, title);
}
