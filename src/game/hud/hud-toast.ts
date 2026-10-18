// HUD の通知(出来事)。画面下部中央の #hud-toast へ警報帯と同じ部品の1行を出し、控えの反映と
// 期限切れのフェードアウトをフレームごとの sync で行う。通知の発行は Notifier の面
// (hint / toast)で受け、バッジの語は種別から導く。
import type { HintKind, Notifier } from '../../hud/notifier';

// 控え中の通知1件ぶん。
interface PendingToast {
  readonly content: string;
  readonly durationMs: number;
  readonly kind: HintKind;
  readonly allowHtml: boolean;
}

// 通知の意味上の種別から、バッジの語を導く — 表示側が本文の文言から類推しない。
const KIND_CODES: Readonly<Record<HintKind, string>> = {
  info: 'SYS', denied: '不可', nav: 'NAV', plan: 'PLN', cleared: '解除',
};

export class HudToast implements Notifier {
  private readonly element: HTMLElement;
  // 次の sync() で表示する通知。
  private pending: PendingToast | null = null;
  // 表示中の通知の期限 [ms, フレームの実時刻と同じ基準]。
  private until: number | null = null;

  // root(#hud)以下に構築済みの #hud-toast を一度だけ引いて保持する。
  public constructor(root: HTMLElement) {
    const element = root.querySelector<HTMLElement>('#hud-toast');
    if (element === null) throw new Error('HUD element missing: hud-toast');
    this.element = element;
  }

  // 本文だけの通知を durationMs 表示する。kind は通知の意味上の種別。
  public hint(text: string, durationMs = 1800, kind: HintKind = 'info'): void {
    this.request(text, durationMs, kind, false);
  }

  // HTML の通知を durationMs 表示する。
  public toast(html: string, durationMs = 8000): void {
    this.request(html, durationMs, 'info', true);
  }

  // 控えがあれば表示を差し替えて期限を張り直し、無ければ期限切れのものを消す。
  // nowMs はフレームの実時刻 [ms]。
  public sync(nowMs: number): void {
    if (this.pending !== null) {
      const line = document.createElement('span');
      line.className = `ui-alert ui-surface-focus is-info is-${this.pending.kind === 'info' ? 'plain' : this.pending.kind}`;
      const code = document.createElement('span');
      code.className = 'ui-alert-level';
      code.textContent = KIND_CODES[this.pending.kind];
      const message = document.createElement('span');
      if (this.pending.allowHtml) message.innerHTML = this.pending.content;
      else message.textContent = this.pending.content;
      line.append(code, message);
      this.element.replaceChildren(line);
      this.element.style.opacity = '1';
      this.until = nowMs + this.pending.durationMs;
      this.pending = null;
    } else if (this.until !== null && nowMs > this.until) {
      this.element.style.opacity = '0';
      this.until = null;
    }
  }

  // 表示したい文言と表示時間を控える。同じフレームに複数控えられたら最後のものが表示される。
  private request(content: string, durationMs: number, kind: HintKind, allowHtml: boolean): void {
    this.pending = { content, durationMs, kind, allowHtml };
  }
}
