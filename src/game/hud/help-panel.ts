// [H] で開閉する操作説明パネル。開閉状態は自身のフィールドで持ち、OverlayManager へ登録する。
// 本文の DOM は dom.ts の buildHelpPanel が組む(責務分割は施策7で扱う)。
import type { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { OverlayHandle, OverlayManager } from './overlay-manager';

export class HelpPanel implements OverlayHandle {
  private _isOpen = false;

  constructor(private readonly el: HTMLElement, private readonly overlayManager: OverlayManager) {}

  get isOpen(): boolean { return this._isOpen; }

  handleInput(input: Input): void {
    if (input.takeKey(K.help)) this.toggle();
  }

  private toggle(): void {
    if (this._isOpen) this.close();
    else this.open();
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.el.style.display = 'block';
    this.overlayManager.open('help', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.el.style.display = 'none';
    this.overlayManager.close('help');
  }

  contains(target: Node): boolean {
    return this.el.contains(target);
  }
}
