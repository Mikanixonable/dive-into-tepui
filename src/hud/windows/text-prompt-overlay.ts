// 文字列入力を要求する共通モーダル(ネイティブ prompt() の HUD 版)。
// OverlayManager の入力ゲート下で ValueInput の確定契約(Enter=確定・Escape=破棄)に載せる。
// 開閉の骨組みは ModalOverlay が持つ。
import { injectOnce } from '../inject-style';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { Button } from '../widgets/button';
import { ValueInput } from '../widgets/value-input';
import { ModalOverlay } from './modal-overlay';

const STYLE = `
#hud .text-prompt-overlay {
  position: absolute; inset: 0; display: grid; place-items: center; padding: var(--space-6);
  pointer-events: auto;
}
#hud .text-prompt-overlay[hidden] { display: none !important; }
#hud .text-prompt-overlay-panel {
  width: min(32rem, calc(100vw - var(--space-6) * 2)); max-height: var(--overlay-max-h-s);
  overflow-y: auto; padding: var(--space-6); color: var(--text);
}
#hud .text-prompt-overlay-title {
  margin: 0 0 var(--space-3); font-size: var(--font-s); font-weight: 600; text-align: center;
}
#hud .text-prompt-overlay-message {
  margin: 0 0 var(--space-4); color: var(--text-dim); font-size: var(--font-s); white-space: pre-wrap;
}
#hud .text-prompt-overlay-body .w-input { width: 100%; }
#hud .text-prompt-overlay-actions {
  display: flex; justify-content: center; gap: var(--space-3); margin-top: var(--space-5);
}
`;

export interface TextPromptOverlayRequest {
  readonly title?: string;
  readonly message?: string;
  // 入力欄の初期値。
  readonly value?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export class TextPromptOverlay implements OverlayHandle {
  private readonly shell: ModalOverlay<string | null>;
  private readonly input: ValueInput;
  private readonly confirm: Button;
  private readonly cancel: Button;

  // モーダルの骨組みへ入力欄と確定/取消ボタンを組み込む。
  public constructor(overlayManager: OverlayManager) {
    injectOnce('text-prompt-overlay', STYLE);
    this.shell = new ModalOverlay<string | null>(overlayManager, 'text-prompt-overlay');
    this.input = new ValueInput({ type: 'text' }, (value) => this.shell.resolve(value), () => this.shell.resolve(null));
    this.shell.body.appendChild(this.input.element);
    this.confirm = new Button('OK', () => this.shell.resolve(this.input.element.value), undefined, 'primary');
    this.cancel = new Button('キャンセル', () => this.shell.resolve(null), undefined, 'secondary');
    this.shell.actions.append(this.confirm.element, this.cancel.element);
    // モーダル内の入力欄の確定契約(blur=確定)をボタン押下と見誤らないよう、
    // パネル上の mousedown ではフォーカスを動かさない — 確定はボタンか Enter だけが起こす。
    this.shell.element.addEventListener('mousedown', (event) => {
      if (event.target !== this.input.element) event.preventDefault();
    });
  }

  // 入力を一枚だけ開く。既存の入力が開いていれば取消として解決してから重ねない。
  // onResult は確定で入力文字列、取消・ESCで null を受け取る。
  public open(request: TextPromptOverlayRequest, onResult: (value: string | null) => void): void {
    this.input.setValue(request.value ?? '');
    this.input.element.placeholder = request.placeholder ?? '';
    this.confirm.setLabel(request.confirmLabel ?? 'OK');
    this.cancel.setLabel(request.cancelLabel ?? 'キャンセル');
    this.shell.open(request, null, onResult);
    this.input.element.focus();
    this.input.element.select();
  }

  public contains(target: Node): boolean { return this.shell.contains(target); }

  // DOM と登録を取り除く。以後このインスタンスは使えない。
  public dispose(): void {
    this.shell.dispose();
  }

  // ESCと取消ボタンを同じ取消結果(null)へ集約する。
  public close(): void {
    this.shell.close();
  }
}
