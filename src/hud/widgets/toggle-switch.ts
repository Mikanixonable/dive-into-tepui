// 見出し + ON/OFF を切り替えるトラック+ノブ型のスイッチ。
import { bindActivation, expandHitTarget, stopDragPropagation } from './widget-base';

export class ToggleSwitch {
  public readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private on = false;

  // title は見出し。onChange は切り替わった後の値で呼ばれる。
  public constructor(title: string, onChange: (on: boolean) => void) {
    this.element = document.createElement('div');
    this.element.className = 'w-toggle';
    const heading = document.createElement('span');
    heading.className = 'w-toggle-title';
    heading.textContent = title;
    this.element.appendChild(heading);

    // クリックを受けるのはトラックで、つまみは表示だけを担う。
    this.track = document.createElement('span');
    this.track.className = 'w-toggle-track';
    this.track.setAttribute('role', 'switch');
    this.track.setAttribute('aria-checked', 'false');
    this.track.tabIndex = 0;
    const knob = document.createElement('span');
    knob.className = 'w-toggle-knob';
    this.track.appendChild(knob);
    stopDragPropagation(this.track);
    expandHitTarget(this.track);
    bindActivation(this.track, () => {
      this.setOn(!this.on);
      onChange(this.on);
    });
    this.element.appendChild(this.track);
  }

  // 表示状態を外部状態に合わせて設定する。
  public setOn(on: boolean): void {
    this.on = on;
    this.track.classList.toggle('on', on);
    this.track.setAttribute('aria-checked', String(on));
  }
}
