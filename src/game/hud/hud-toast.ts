// HUD のトースト通知。通知レイヤ上の #hud-toast 要素へ文言を出し、控えの反映と
// 期限切れのフェードアウトをフレームごとの sync で行う。通知の発行は Notifier の
// 面(hint / toast)で受け、バッジの記号と警告色はここで導く。
import type { HintKind, Notifier } from '../../hud/notifier';

// 控え中のトースト1件ぶん。
interface PendingToast {
  readonly content: string;
  readonly durationMs: number;
  readonly code: string;
  readonly warning: boolean;
  readonly allowHtml: boolean;
}

// 通知の意味上の種別からバッジの記号を導く — 表示側が本文の文言から類推しない。
function hintCode(kind: HintKind): string {
  return kind === 'warn' ? 'WARN' : kind === 'nav' ? 'NAV' : kind === 'plan' ? 'PLN' : 'SYS';
}

export class HudToast implements Notifier {
  private readonly element: HTMLElement;
  // 次の sync() で表示するトースト。
  private pending: PendingToast | null = null;
  // 表示中のトーストの期限 [ms, フレームの実時刻と同じ基準]。
  private until: number | null = null;

  // root(#hud)以下に構築済みの #hud-toast を一度だけ引いて保持する。
  public constructor(root: HTMLElement) {
    const element = root.querySelector<HTMLElement>('#hud-toast');
    if (element === null) throw new Error('HUD element missing: hud-toast');
    this.element = element;
  }

  // 本文だけのトーストを durationMs 表示する。kind は通知の意味上の種別。
  public hint(text: string, durationMs = 1800, kind: HintKind = 'info'): void {
    this.request(text, durationMs, hintCode(kind), kind === 'warn', false);
  }

  // 見出しと本文を持つ HTML のトーストを durationMs 表示する。
  public toast(html: string, durationMs = 8000): void {
    this.request(html, durationMs, 'SYS', false, true);
  }

  // 控えがあれば表示を差し替えて期限を張り直し、無ければ期限切れのものを消す。
  // nowMs はフレームの実時刻 [ms]。
  public sync(nowMs: number): void {
    if (this.pending !== null) {
      const code = document.createElement('span');
      code.className = 'toast-code';
      code.textContent = this.pending.code;
      const message = document.createElement('div');
      message.className = 'toast-message';
      if (this.pending.allowHtml) message.innerHTML = this.pending.content;
      else message.textContent = this.pending.content;
      this.element.replaceChildren(code, message);
      this.element.classList.toggle('warn', this.pending.warning);
      this.element.style.opacity = '1';
      this.until = nowMs + this.pending.durationMs;
      this.pending = null;
    } else if (this.until !== null && nowMs > this.until) {
      this.element.style.opacity = '0';
      this.until = null;
    }
  }

  // 表示したい文言と表示時間を控える。同じフレームに複数控えられたら最後のものが表示される。
  private request(
    content: string, durationMs: number, code: string, warning: boolean, allowHtml: boolean,
  ): void {
    this.pending = { content, durationMs, code, warning, allowHtml };
  }
}
