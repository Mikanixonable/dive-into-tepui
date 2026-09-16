// [H] と常設の起動ボタンで開閉する操作説明のモーダル。操作の対応表を1枚の表として出す。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { injectOnce } from '../../../hud/inject-style';
import { injectCommonUiStyle } from '../../../hud/style/common-ui-style';
import { CloseButton } from '../../../hud/widgets/close-button';
import { stopDragPropagation } from '../../../hud/widgets/widget-base';
import { HELP_PANEL_STYLE } from '../style/help-panel-style';
import { helpRows } from './help-content';
import type { OverlayHandle, OverlayManager } from '../../../hud/overlay-manager';

export class HelpPanel implements OverlayHandle {
  private readonly el: HTMLElement;
  private _isOpen = false;

  // 操作説明の DOM を組み立てて root へ追加する。閉じた状態で始まる。
  public constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    injectCommonUiStyle();
    injectOnce('help-panel', HELP_PANEL_STYLE);
    this.el = document.createElement('div');
    this.el.id = 'hud-help';
    this.el.className = 'panel ui-surface-focus';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'hud-help-title');
    // 見出しと閉じるボタン、表の器。
    this.el.innerHTML = `
      <div class="help-header">
        <h3 id="hud-help-title">操作説明 <span>[${K.help.label} / ${K.pauseMenu.label} で閉じる]</span></h3>
      </div>
      <div class="help-body"><table></table></div>
    `;
    this.el.querySelector('.help-header')!.appendChild(new CloseButton(() => this.close()).element);
    // 対応表の行。文言は textContent で入れる。
    const table = this.el.querySelector('table')!;
    for (const row of helpRows()) {
      const tr = table.insertRow();
      tr.insertCell().textContent = row.input;
      const label = document.createElement('strong');
      label.textContent = row.label;
      const description = document.createElement('p');
      description.textContent = row.description;
      tr.insertCell().append(label, description);
    }
    root.appendChild(this.el);
    stopDragPropagation(this.el);
  }

  public get isOpen(): boolean { return this._isOpen; }

  // router から [H] の単発入力を受け取って開閉を切り替える。
  public handleCommand(commandId: string): void {
    if (commandId !== K.help.code) return;
    if (this._isOpen) this.close();
    else this.open();
  }

  // パネルを開く。既に開いていれば何もしない。
  public open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.el.style.display = 'flex';
    // 系のモーダル(ヘルプ・一時停止など)は同じ排他グループに属し、同時に1つしか開かない。
    this.overlayManager.open('help', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
  }

  // パネルを閉じる。既に閉じていれば何もしない。
  public close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.el.style.display = 'none';
    this.overlayManager.close('help');
  }

  // 指定したノードがこのパネルの DOM 内にあるかを判定する。
  public contains(target: Node): boolean {
    return this.el.contains(target);
  }
}
