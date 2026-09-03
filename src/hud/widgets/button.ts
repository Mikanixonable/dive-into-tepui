// 単発クリックのボタン。押すと onClick を呼ぶ。on(点灯)/disabled の表示は呼び出し側が
// setOn/setEnabled で与える。点灯型トグルは setOn を外から呼ぶ形でこのボタンに表現させる。
import { bindActivation, expandHitTarget, stopDragPropagation } from './widget-base';

export class Button {
  public readonly element: HTMLElement;
  private enabled = true;
  private readonly labelEl: HTMLElement | null;

  // label はボタンの表示文字列。onClick はクリック(またはキーボード操作)のたびに呼ばれる。
  // icon を渡すと、その SVG/文字マークアップをラベルの前に添える。
  public constructor(label: string, onClick: () => void, icon?: string) {
    this.element = document.createElement('span');
    this.element.className = 'w-btn';
    if (icon !== undefined) {
      const iconEl = document.createElement('span');
      iconEl.className = 'w-btn-icon';
      iconEl.setAttribute('aria-hidden', 'true');
      iconEl.innerHTML = icon;
      this.element.appendChild(iconEl);
      this.labelEl = document.createElement('span');
      this.labelEl.textContent = label;
      this.element.appendChild(this.labelEl);
    } else {
      this.element.textContent = label;
      this.labelEl = null;
    }
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
    bindActivation(this.element, () => { if (this.enabled) onClick(); });
  }

  // ボタンの表示文字列を差し替える。
  public setLabel(label: string): void {
    if (this.labelEl !== null) this.labelEl.textContent = label;
    else this.element.textContent = label;
  }

  // 点灯表示を外部状態に合わせて設定する。呼び出し側が onClick 内などから setOn を呼んで反映する。
  public setOn(on: boolean): void {
    this.element.classList.toggle('on', on);
    this.element.setAttribute('aria-pressed', String(on));
  }

  // 無効化を切り替える。有効なときにクリック・キーボード操作が onClick を呼ぶ。
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.element.classList.toggle('disabled', !enabled);
    this.element.setAttribute('aria-disabled', String(!enabled));
  }
}
