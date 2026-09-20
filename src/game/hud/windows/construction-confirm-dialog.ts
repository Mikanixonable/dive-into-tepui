import { Button } from '../../../hud/widgets';
import type { OverlayHandle, OverlayManager } from '../../../hud/overlay-manager';
import type {
  ConstructionConfirmationPort, ConstructionConfirmationRequest,
} from '../../ship/ship-construction-types';

// 建造の完成・破棄を、ブラウザ標準ダイアログではなくHUDのモーダルとして確認する。
export class ConstructionConfirmDialog implements OverlayHandle, ConstructionConfirmationPort {
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private readonly confirm: Button;
  private readonly cancel: Button;
  private onResult: ((confirmed: boolean) => void) | null = null;
  private openState = false;

  // construction専用の確認内容だけを差し替え、OverlayManagerのモーダル契約へ接続する。
  public constructor(
    root: HTMLElement, private readonly overlayManager: OverlayManager,
  ) {
    this.panel = document.createElement('section');
    this.panel.id = 'ship-construction-confirm';
    this.panel.className = 'panel ui-surface-focus construction-confirm-dialog';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.title = document.createElement('h3');
    this.message = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'construction-confirm-actions';
    this.confirm = new Button('確定', () => this.resolve(true), undefined, 'primary');
    this.cancel = new Button('取り消し', () => this.resolve(false), undefined, 'secondary');
    actions.append(this.cancel.element, this.confirm.element);
    this.panel.append(this.title, this.message, actions);
    this.panel.style.display = 'none';
    root.appendChild(this.panel);
  }

  // 既存確認中は取消として解決してから、新しい確認を一枚だけ開く。
  public request(
    request: ConstructionConfirmationRequest, onResult: (confirmed: boolean) => void,
  ): void {
    if (this.openState) this.resolve(false);
    this.openState = true;
    this.onResult = onResult;
    this.title.textContent = request.title;
    this.message.textContent = request.message;
    this.confirm.setLabel(request.confirmLabel);
    this.panel.dataset['destructive'] = String(request.destructive === true);
    this.panel.style.display = 'grid';
    this.overlayManager.open('ship-construction-confirm', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: true, dimsBackground: true, pausesGame: true,
    });
  }

  // OverlayManagerが外側入力を判定するための包含判定。
  public contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // ESCと取消ボタンを同じ取消結果へ集約する。
  public close(): void {
    if (!this.openState) return;
    this.resolve(false);
  }

  // 結果callback、DOM、OverlayManagerを一度だけ同時に閉じる。
  private resolve(confirmed: boolean): void {
    if (!this.openState) return;
    this.openState = false;
    const callback = this.onResult;
    this.onResult = null;
    this.panel.style.display = 'none';
    this.overlayManager.close('ship-construction-confirm');
    callback?.(confirmed);
  }
}
