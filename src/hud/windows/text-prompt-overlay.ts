// 文字列入力を要求する共通モーダル(ネイティブ prompt() の HUD 版)。
// OverlayManager の入力ゲート下で ValueInput の確定契約(Enter=確定・Escape=破棄)に載せる。
import { injectOnce } from '../inject-style';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { Button } from '../widgets/button';
import { ValueInput } from '../widgets/value-input';

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
#hud .text-prompt-overlay-input .w-input { width: 100%; }
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

// 1つの OverlayManager に同じ id で複数登録されると前のオーバーレイが管理を失うため、
// インスタンスごとに固有の id を割り当てる。
let nextOverlayId = 1;

export class TextPromptOverlay implements OverlayHandle {
  private readonly overlayId = `text-prompt-overlay-${nextOverlayId++}`;
  private readonly element: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly input: ValueInput;
  private readonly confirm: Button;
  private readonly cancel: Button;
  private onResult: ((value: string | null) => void) | null = null;
  private openState = false;

  public constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    injectOnce('text-prompt-overlay', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'text-prompt-overlay';
    this.element.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'text-prompt-overlay-panel ui-surface-focus';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    this.title = document.createElement('h3');
    this.title.className = 'text-prompt-overlay-title';
    panel.appendChild(this.title);
    this.message = document.createElement('p');
    this.message.className = 'text-prompt-overlay-message';
    panel.appendChild(this.message);
    const inputWrap = document.createElement('div');
    inputWrap.className = 'text-prompt-overlay-input';
    this.input = new ValueInput({ type: 'text' }, (value) => this.resolve(value), () => this.resolve(null));
    inputWrap.appendChild(this.input.element);
    panel.appendChild(inputWrap);
    const actions = document.createElement('div');
    actions.className = 'text-prompt-overlay-actions';
    this.confirm = new Button('OK', () => this.resolve(this.input.element.value), undefined, 'primary');
    this.cancel = new Button('キャンセル', () => this.resolve(null), undefined, 'secondary');
    actions.append(this.confirm.element, this.cancel.element);
    panel.appendChild(actions);
    this.element.appendChild(panel);
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());
    // モーダル内の入力欄の確定契約(blur=確定)をボタン押下と見誤らないよう、
    // パネル上の mousedown ではフォーカスを動かさない — 確定はボタンか Enter だけが起こす。
    this.element.addEventListener('mousedown', (event) => {
      if (event.target !== this.input.element) event.preventDefault();
    });
    root.appendChild(this.element);
  }

  // 入力を一枚だけ開く。既存の入力が開いていれば取消として解決してから重ねない。
  // onResult は確定で入力文字列、取消・ESCで null を受け取る。
  public open(request: TextPromptOverlayRequest, onResult: (value: string | null) => void): void {
    this.resolve(null);
    this.openState = true;
    this.onResult = onResult;
    this.title.textContent = request.title ?? '';
    this.title.hidden = request.title === undefined || request.title === '';
    this.message.textContent = request.message ?? '';
    this.message.hidden = request.message === undefined || request.message === '';
    this.input.setValue(request.value ?? '');
    this.input.element.placeholder = request.placeholder ?? '';
    this.confirm.setLabel(request.confirmLabel ?? 'OK');
    this.cancel.setLabel(request.cancelLabel ?? 'キャンセル');
    this.element.hidden = false;
    this.overlayManager.open(this.overlayId, this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: true, dimsBackground: true, pausesGame: true,
    });
    this.input.element.focus();
    this.input.element.select();
  }

  public contains(target: Node): boolean { return this.element.contains(target); }

  public dispose(): void {
    this.close();
    this.element.remove();
  }

  // ESCと取消ボタンを同じ取消結果へ集約する。
  public close(): void {
    this.resolve(null);
  }

  // 結果callback、DOM、OverlayManagerを一度だけ同時に閉じる。
  private resolve(value: string | null): void {
    if (!this.openState) return;
    this.openState = false;
    const callback = this.onResult;
    this.onResult = null;
    this.element.hidden = true;
    this.overlayManager.close(this.overlayId);
    callback?.(value);
  }
}
