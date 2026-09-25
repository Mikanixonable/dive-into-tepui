// 取り消しにくい操作を OverlayManager の入力ゲート下で確認する共通モーダル。
// 建造の確定確認(ConstructionConfirmationPort)を含め、題名+説明+確定/取消の確認は
// すべてこの1枚が担う。
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
#hud .confirmation-overlay-title {
  margin: 0 0 var(--space-3); font-size: var(--font-s); font-weight: 600;
}
#hud .confirmation-overlay-panel[data-destructive="true"] .confirmation-overlay-title {
  color: var(--color-warning);
}
#hud .confirmation-overlay-message { margin-bottom: var(--space-5); white-space: pre-wrap; }
#hud .confirmation-overlay-actions { display: flex; justify-content: center; gap: var(--space-3); }
`;

export interface ConfirmationOverlayRequest {
  readonly title?: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  // 破壊的な操作の確認なら true。題名を警告色へ変える。
  readonly destructive?: boolean;
}

// 1つの OverlayManager に同じ id で複数登録されると前のオーバーレイが管理を失うため、
// インスタンスごとに固有の id を割り当てる。
let nextOverlayId = 1;

export class ConfirmationOverlay implements OverlayHandle {
  private readonly overlayId = `confirmation-overlay-${nextOverlayId++}`;
  private readonly element: HTMLDivElement;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLParagraphElement;
  private readonly confirm: Button;
  private readonly cancel: Button;
  private onResult: ((confirmed: boolean) => void) | null = null;
  private openState = false;

  public constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    injectOnce('confirmation-overlay', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'confirmation-overlay';
    this.element.hidden = true;
    this.panel = document.createElement('div');
    this.panel.className = 'confirmation-overlay-panel ui-surface-focus';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.title = document.createElement('h3');
    this.title.className = 'confirmation-overlay-title';
    this.panel.appendChild(this.title);
    this.message = document.createElement('p');
    this.message.className = 'confirmation-overlay-message';
    this.panel.appendChild(this.message);
    const actions = document.createElement('div');
    actions.className = 'confirmation-overlay-actions';
    this.confirm = new Button('実行', () => this.resolve(true), undefined, 'primary');
    this.cancel = new Button('キャンセル', () => this.resolve(false), undefined, 'secondary');
    actions.append(this.confirm.element, this.cancel.element);
    this.panel.appendChild(actions);
    this.element.appendChild(this.panel);
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());
    root.appendChild(this.element);
  }

  // 確認を一枚だけ開く。既存の確認が開いていれば取消として解決してから重ねない。
  // onResult は確定で true、取消・ESCで false を受け取る。
  public open(request: ConfirmationOverlayRequest, onResult: (confirmed: boolean) => void): void {
    this.resolve(false);
    this.openState = true;
    this.onResult = onResult;
    this.title.textContent = request.title ?? '';
    this.title.hidden = request.title === undefined || request.title === '';
    this.message.textContent = request.message;
    this.confirm.setLabel(request.confirmLabel ?? '実行');
    this.cancel.setLabel(request.cancelLabel ?? 'キャンセル');
    this.panel.dataset['destructive'] = String(request.destructive === true);
    this.element.hidden = false;
    this.overlayManager.open(this.overlayId, this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: true, dimsBackground: true, pausesGame: true,
    });
    this.confirm.element.focus();
  }

  // open() と同じ要求形状の別名。要求/結果の契約を持つ呼び出し側はこちらを使う。
  public request(request: ConfirmationOverlayRequest, onResult: (confirmed: boolean) => void): void {
    this.open(request, onResult);
  }

  public contains(target: Node): boolean { return this.element.contains(target); }

  public dispose(): void {
    this.close();
    this.element.remove();
  }

  // ESCと取消ボタンを同じ取消結果へ集約する。
  public close(): void {
    this.resolve(false);
  }

  // 結果callback、DOM、OverlayManagerを一度だけ同時に閉じる。
  private resolve(confirmed: boolean): void {
    if (!this.openState) return;
    this.openState = false;
    const callback = this.onResult;
    this.onResult = null;
    this.element.hidden = true;
    this.overlayManager.close(this.overlayId);
    callback?.(confirmed);
  }
}
