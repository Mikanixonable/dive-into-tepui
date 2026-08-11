// HUD モーダルの開閉状態と入力ゲートを一つの状態機械で管理する。
// 表示 DOM の computed style を後から読んで状態を推測すると、モーダル同士の切替中や
// 再構築後にシールドだけが残る/消えるため、開閉側が明示的に状態を通知する。

export type HudModalId = 'help' | 'settings' | 'save-browser';

export class ModalController {
  private readonly openModals = new Set<HudModalId>();
  private readonly backgroundInputModals = new Set<HudModalId>();

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

  // allowBackgroundInput はモーダル外のカメラ入力だけを通したい画面向け。モーダル自身の
  // UI は各要素の pointer-events:auto で優先され、通常のモーダルは従来どおり背景を遮る。
  setOpen(id: HudModalId, open: boolean, allowBackgroundInput = false): void {
    if (open) {
      this.openModals.add(id);
      if (allowBackgroundInput) this.backgroundInputModals.add(id);
      else this.backgroundInputModals.delete(id);
    }
    else {
      this.openModals.delete(id);
      this.backgroundInputModals.delete(id);
    }
    this.sync();
  }

  private sync(): void {
    const open = this.isOpen;
    const gateInput = [...this.openModals].some((id) => !this.backgroundInputModals.has(id));
    this.shield.style.pointerEvents = gateInput ? 'auto' : 'none';
    this.gateLayer.classList.toggle('modal-input-gate', gateInput);
    document.body.classList.toggle('hud-modal-open', open);
    if (open) window.dispatchEvent(new Event('tepui-release-touch-inputs'));
  }
}
