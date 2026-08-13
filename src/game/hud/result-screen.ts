import { KEY_MAPPING as K } from '../input/key-mapping';
import type { StageResult } from '../stages/stage';
import { FONT_L, SPACE_6, TEXT_DIM } from '../theme';

// 決着した周回の次を決める側。結果画面の2つのボタンはこれを呼ぶ。
export interface RunTransitions {
  restart(): void;
  returnToTitle(): void;
}

// #hud-end の表示だけを担う。次に何をするかは注入された transitions が決める。
export class ResultScreen {
  constructor(private readonly transitions: RunTransitions) {}

  // result の内容で #hud-end を組み立てて表示する。
  show(result: StageResult): void {
    const e = document.getElementById('hud-end');
    if (!e) return;
    e.className = result.win ? 'win' : 'lose';
    e.style.display = 'flex';
    e.style.pointerEvents = 'auto';
    e.innerHTML = `
      <h1>${result.title ?? (result.win ? 'MISSION COMPLETE' : 'SHIP LOST')}</h1>
      <div class="detail">${result.detailHtml}</div>
      <div class="restart" style="cursor: pointer;">[${K.restart.label}] キーまたはタップで再出撃</div>
      <div class="title-return" style="margin-top: ${SPACE_6}; color: ${TEXT_DIM}; font-size: ${FONT_L}; cursor: pointer; text-decoration: underline;">タイトル画面に戻る</div>`;
    e.querySelector('.restart')!.addEventListener('click', () => this.transitions.restart());
    e.querySelector('.title-return')!.addEventListener('click', () => this.transitions.returnToTitle());
  }

  hide(): void {
    const e = document.getElementById('hud-end');
    if (!e) return;
    e.style.display = 'none';
    e.style.pointerEvents = 'none';
  }
}
