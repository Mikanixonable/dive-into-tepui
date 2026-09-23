// 取り消しにくい操作を OverlayManager の入力ゲート下で確認する共通モーダル。
import { injectOnce } from '../inject-style';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { Button } from '../widgets/button';

const STYLE = `
#hud .confirmation-overlay {
  position: absolute; inset: 0; display: grid; place-items: center; padding: var(--space-6);
  pointer-events: auto;
}
#hud .confirmation-overlay[hidden] { display: none !important; }
#hud .confirmation-overlay-panel {
  width: min(32rem, calc(100vw - var(--space-6) * 2)); max-height: var(--overlay-max-h-s);
  overflow-y: auto; padding: var(--space-6); color: var(--text); text-align: center;
}
#hud .confirmation-overlay-message { margin-bottom: var(--space-5); white-space: pre-wrap; }
#hud .confirmation-overlay-actions { display: flex; justify-content: center; gap: var(--space-3); }
`;

export class ConfirmationOverlay implements OverlayHandle {
  private readonly element: HTMLDivElement;
  private readonly message: HTMLParagraphElement;
  private readonly confirm: Button;
  private readonly cancel: Button;
  private onConfirm: (() => void) | null = null;

  public constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    injectOnce('confirmation-overlay', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'confirmation-overlay';
    this.element.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'confirmation-overlay-panel ui-surface-focus';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    this.message = document.createElement('p');
    this.message.className = 'confirmation-overlay-message';
    panel.appendChild(this.message);
    const actions = document.createElement('div');
    actions.className = 'confirmation-overlay-actions';
    this.confirm = new Button('実行', () => this.accept(), undefined, 'primary');
    this.cancel = new Button('キャンセル', () => this.close(), undefined, 'secondary');
    actions.append(this.confirm.element, this.cancel.element);
    panel.appendChild(actions);
    this.element.appendChild(panel);
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());
    root.appendChild(this.element);
  }

  public open(message: string, onConfirm: () => void): void {
    this.close();
    this.message.textContent = message;
    this.onConfirm = onConfirm;
    this.element.hidden = false;
    this.overlayManager.open('confirmation-overlay', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: true, pausesGame: true,
    });
    this.confirm.element.focus();
  }

  public contains(target: Node): boolean { return this.element.contains(target); }

  public dispose(): void {
    this.close();
    this.element.remove();
  }

  public close(): void {
    this.onConfirm = null;
    this.element.hidden = true;
    this.overlayManager.close('confirmation-overlay');
  }

  private accept(): void {
    const action = this.onConfirm;
    this.close();
    action?.();
  }
}
