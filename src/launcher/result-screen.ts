import { KEY_MAPPING as K } from '../input/key-mapping';
import type { StageResult } from '../game/stages/stage';
import { FONT_L, SPACE_6 } from '../theme';
import type { HudShell } from '../hud/hud-shell';
import { createHudElement } from '../hud/hud-element';
import type { OverlayHandle } from '../hud/overlay-manager';
import { injectOnce } from '../hud/widgets/inject-style';
import { RESULT_SCREEN_STYLE } from './result-screen-style';

// 決着した周回の次(再出撃かタイトルへ戻るか)を決める契約。
export interface RunTransitions {
  restart(): void;
  returnToTitle(): void;
}

// 結果画面(#hud-result)の表示と OverlayManager 登録を担う。次に何をするかは注入された
// transitions が決める。ESC・外側クリックでは閉じない — 登録するのは入力ゲート
// (タッチパッドの解放・背景入力の遮断)のためで、実際に閉じるのは close() の呼び出しだけ。
export class ResultScreen implements OverlayHandle {
  private readonly element: HTMLElement;

  public constructor(
    private readonly shell: HudShell,
    private readonly transitions: RunTransitions,
  ) {
    injectOnce('result-screen-style', RESULT_SCREEN_STYLE);
    this.element = createHudElement('div', 'hud-result', shell.layers.system);
  }

  // OverlayHandle 実装。target が結果画面の内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.element.contains(target);
  }

  // 何も表示していない状態で呼んでも安全。
  public close(): void {
    this.element.style.display = 'none';
    this.element.style.pointerEvents = 'none';
    this.shell.overlayManager.close('result');
  }

  // result の内容で結果画面を組み立てて表示する。
  public show(result: StageResult): void {
    const e = this.element;
    // 勝敗に応じたクラスと文言で中身を組み立てる。
    e.className = result.win ? 'win' : 'lose';
    e.style.display = 'flex';
    e.style.pointerEvents = 'auto';
    e.innerHTML = `
      <h1>${result.title ?? (result.win ? 'MISSION COMPLETE' : 'SHIP LOST')}</h1>
      <div class="detail">${result.detailHtml}</div>
      <div class="restart" style="cursor: pointer;">[${K.restart.label}] キーまたはタップで再出撃</div>
      <div class="title-return" style="margin-top: ${SPACE_6}; color: var(--text-dim); font-size: ${FONT_L}; cursor: pointer; text-decoration: underline;">タイトル画面に戻る</div>`;
    e.querySelector('.restart')!.addEventListener('click', () => this.transitions.restart());
    e.querySelector('.title-return')!.addEventListener('click', () => this.transitions.returnToTitle());
    // 背景入力を遮断する入力ゲートとして登録する。
    this.shell.overlayManager.open('result', this, {
      kind: 'modal', closeOnEscape: false, closeOnOutsideClick: false, gatesInput: true,
    });
  }
}
