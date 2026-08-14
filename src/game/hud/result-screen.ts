import { KEY_MAPPING as K } from '../input/key-mapping';
import type { StageResult } from '../stages/stage';
import { FONT_L, SPACE_6, TEXT_DIM } from '../theme';
import type { Hud } from './hud';
import type { OverlayHandle } from './overlay-manager';

// 決着した周回の次を決める側。結果画面の2つのボタンはこれを呼ぶ。
export interface RunTransitions {
  restart(): void;
  returnToTitle(): void;
}

// 結果画面(#hud-result)の表示と OverlayManager 登録を担う。次に何をするかは注入された
// transitions が決める。閉じる手段は再出撃/タイトルへの遷移(いずれもページ離脱かリロードで
// 表現される)のみなので、ESC・外側クリックでは閉じない — 登録するのは入力ゲート
// (タッチパッドの解放・背景入力の遮断)のためだけ。
export class ResultScreen implements OverlayHandle {
  constructor(
    private readonly hud: Hud,
    private readonly transitions: RunTransitions,
  ) {}

  contains(target: Node): boolean {
    return document.getElementById('hud-result')?.contains(target) ?? false;
  }

  close(): void {}

  // result の内容で #hud-result を組み立てて表示する。
  show(result: StageResult): void {
    const e = document.getElementById('hud-result');
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
    this.hud.overlayManager.open('result', this, {
      kind: 'modal', closeOnEscape: false, closeOnOutsideClick: false, gatesInput: true,
    });
  }
}
