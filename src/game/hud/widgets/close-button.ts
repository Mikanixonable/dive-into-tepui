// ✕ の閉じるボタン。
import { expandHitTarget, stopDragPropagation } from './widget-base';

export class CloseButton {
  readonly element: HTMLElement;

  // onClick はクリックのたびに呼ばれる。
  constructor(onClick: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    this.element = button;
    this.element.className = 'w-close';
    this.element.textContent = '✕';
    this.element.setAttribute('aria-label', '閉じる');
    stopDragPropagation(this.element);
    expandHitTarget(this.element);
    // native <button> の click には role/aria の付与が要らず、Enter/Space も標準で発火する。
    this.element.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
  }
}
