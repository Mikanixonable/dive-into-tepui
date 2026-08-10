// HUD モーダルの開閉状態と入力ゲートを一つの状態機械で管理する。
// 表示 DOM の computed style を後から読んで状態を推測すると、モーダル同士の切替中や
// 再構築後にシールドだけが残る/消えるため、開閉側が明示的に状態を通知する。

export type HudModalId = 'help' | 'settings' | 'save-browser';

export class ModalController {
  private readonly openModals = new Set<HudModalId>();

  constructor(private readonly shield: HTMLElement, private readonly gateLayer: HTMLElement) {
    shield.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    shield.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.sync();
  }

  get openCount(): number { return this.openModals.size; }
  get isOpen(): boolean { return this.openModals.size > 0; }

  setOpen(id: HudModalId, open: boolean): void {
    if (open) this.openModals.add(id);
    else this.openModals.delete(id);
    this.sync();
  }

  private sync(): void {
    const open = this.isOpen;
    this.shield.style.pointerEvents = open ? 'auto' : 'none';
    this.gateLayer.classList.toggle('modal-input-gate', open);
    document.body.classList.toggle('hud-modal-open', open);
    if (open) window.dispatchEvent(new Event('tepui-release-touch-inputs'));
  }
}
