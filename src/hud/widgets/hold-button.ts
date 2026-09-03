// 押している間 isHeld が true になるボタン。呼び出し側がゲームループから毎フレーム isHeld を
// 読み、押している間だけ処理を続ける形で使う。
import { expandHitTarget, stopDragPropagation } from './widget-base';

export class HoldButton {
  public readonly element: HTMLElement;
  private held = false;

  public get isHeld(): boolean {
    return this.held;
  }

  // label はボタンの表示文字列。
  public constructor(label: string) {
    this.element = document.createElement('span');
    this.element.className = 'w-btn w-hold';
    this.element.textContent = label;
    stopDragPropagation(this.element);
    expandHitTarget(this.element);
    this.element.addEventListener('pointerdown', (e) => {
      this.held = true;
      this.element.classList.add('pressed');
      this.element.setPointerCapture(e.pointerId);
    });
    // pointerup と pointercancel の両方で isHeld を戻し、途中でポインタが外れても held のまま
    // 固定されないようにする。
    const release = (e: PointerEvent): void => {
      this.held = false;
      this.element.classList.remove('pressed');
      try {
        this.element.releasePointerCapture(e.pointerId);
      } catch {
        /* すでに解放済みなら無視 */
      }
    };
    this.element.addEventListener('pointerup', release);
    this.element.addEventListener('pointercancel', release);
    this.element.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
