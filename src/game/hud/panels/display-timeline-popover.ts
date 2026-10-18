// 時間軸のトリガーの上に開く小窓。表示範囲の選択と、目盛り・凡例の設定が使う。
// ESC・外側クリックでの閉じ方は OverlayManager が決める。
import { CloseButton } from '../../../hud/widgets';
import { clampOverlayPosition } from '../../../hud/layout';
import { injectCommonUiStyle } from '../../../hud/style/common-ui-style';
import type { OverlayHandle, OverlayManager } from '../../../hud/overlay-manager';

// 小窓の左右をトリガーのどちら側へ揃えるか。
export type PopoverAlign = 'start' | 'end';

export class TimelinePopover implements OverlayHandle {
  private static nextId = 0;
  // 見出しの下に中身を足す要素。
  public readonly body: HTMLElement;
  private readonly overlayId: string;
  private readonly element: HTMLElement;
  private trigger: HTMLElement | null = null;

  // title は見出し、className は小窓に足す配置用のクラス。開くまでは DOM へ挿さない。
  public constructor(private readonly overlayManager: OverlayManager, title: string, className: string) {
    injectCommonUiStyle();
    this.overlayId = `display-timeline-popover-${TimelinePopover.nextId++}`;
    this.element = document.createElement('div');
    this.element.className = `tml-pop ui-surface-focus ${className}`;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', title);
    this.element.addEventListener('pointerdown', (e) => e.stopPropagation());
    const head = document.createElement('div');
    head.className = 'tml-pop-head';
    const heading = document.createElement('span');
    heading.className = 'ui-sub';
    heading.textContent = title;
    head.append(heading, new CloseButton(() => this.close()).element);
    this.body = document.createElement('div');
    this.element.append(head, this.body);
  }

  public get isOpen(): boolean {
    return this.overlayManager.isOverlayOpen(this.overlayId);
  }

  // 小窓かそれを開いたトリガーの内側か。トリガーの押下は開閉の切り替えが受け持つので、外側扱いにしない。
  public contains(target: Node): boolean {
    return this.element.contains(target) || (this.trigger?.contains(target) ?? false);
  }

  // 開いていれば閉じ、閉じていれば trigger の上に開く。小窓の上下は above の上端に揃え、左右は
  // align に従って trigger に揃える。
  public toggle(trigger: HTMLElement, align: PopoverAlign, above: HTMLElement): void {
    if (this.isOpen) {
      this.close();
      return;
    }
    this.trigger = trigger;
    this.element.style.display = 'block';
    this.overlayManager.open(this.overlayId, this.element, this, {
      kind: 'popup', closeOnEscape: true, closeOnOutsideClick: true, gatesInput: false,
    });
    // 画面端でもはみ出さないよう、実寸を測ってから位置を決める。
    const anchor = trigger.getBoundingClientRect();
    const size = this.element.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: align === 'start' ? anchor.left : anchor.right - size.width, y: 0 }, size,
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.element.style.left = `${pos.x}px`;
    this.element.style.bottom = `${window.innerHeight - above.getBoundingClientRect().top}px`;
  }

  public close(): void {
    this.element.style.display = 'none';
    this.overlayManager.close(this.overlayId);
  }

  // 開いていれば閉じ、小窓の DOM を取り除く。
  public dispose(): void {
    this.close();
    this.element.remove();
  }
}
