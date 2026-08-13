// 単発クリックのボタン。押すと onClick が呼ばれるだけで、on(点灯)/disabled の表示は
// 呼び出し側が setOn/setEnabled で与える — 自分では状態を反転しない。点灯型トグルは
// これに setOn を外から呼ぶ形で表現し、別ウィジェットを持たない。
import { expandHitTarget, stopDragPropagation } from './widget-base';

export class Button {
  readonly element: HTMLElement;
  private enabled = true;

  // label はボタンの表示文字列。onClick はクリック(またはキーボード操作)のたびに呼ばれる。
  constructor(label: string, onClick: () => void) {
    this.element = document.createElement('span');
    this.element.className = 'w-btn';
    this.element.textContent = label;
    this.element.setAttribute('role', 'button');
    this.element.tabIndex = 0;
    stopDragPropagation(this.element);
    expandHitTarget(this.element);
    // タッチと :active の見た目の差を、JS で付けた pressed クラスに一本化する。
    this.element.addEventListener('pointerdown', () => {
      if (this.enabled) this.element.classList.add('pressed');
    });
    const release = (): void => this.element.classList.remove('pressed');
    this.element.addEventListener('pointerup', release);
    this.element.addEventListener('pointerleave', release);
    this.element.addEventListener('pointercancel', release);
    this.element.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.enabled) onClick();
    });
    // role="button" だけでは Enter/Space が click を発火しないため、明示的に発火させる。
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.element.click();
      }
    });
  }

  setLabel(label: string): void {
    this.element.textContent = label;
  }

  // 点灯表示を設定する。押されるたびに自分で反転はしない — onClick 側が setOn を呼ぶ。
  setOn(on: boolean): void {
    this.element.classList.toggle('on', on);
    this.element.setAttribute('aria-pressed', String(on));
  }

  // 無効化する。無効中はクリック・キーボード操作のいずれも onClick を呼ばない。
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.element.classList.toggle('disabled', !enabled);
    this.element.setAttribute('aria-disabled', String(!enabled));
  }
}
