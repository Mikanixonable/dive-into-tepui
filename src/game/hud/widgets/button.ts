// 単発クリックのボタン。押すと onClick が呼ばれるだけで、on(点灯)/disabled の表示は
// 呼び出し側が setOn/setEnabled で与える — 自分では状態を反転しない。点灯型トグルは
// これに setOn を外から呼ぶ形で表現し、別ウィジェットを持たない。
import { bindActivation, expandHitTarget, stopDragPropagation } from './widget-base';

export class Button {
  readonly element: HTMLElement;
  private enabled = true;
  private readonly labelEl: HTMLElement | null;

  // label はボタンの表示文字列。onClick はクリック(またはキーボード操作)のたびに呼ばれる。
  // icon を渡すと、その SVG/文字マークアップをラベルの前に添える。
  constructor(label: string, onClick: () => void, icon?: string) {
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

  setLabel(label: string): void {
    if (this.labelEl !== null) this.labelEl.textContent = label;
    else this.element.textContent = label;
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
