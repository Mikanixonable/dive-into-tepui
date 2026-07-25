// マップモードのツールバー(予測期間・座標系・フォーカス・視点リセット・未来位置スライダー)。
// 旧 Hud のツールバーまわり(DOM 構築・状態反映・コールバック)を一手に所有する。
// CSS(#hud-maptool)は hud/dom.ts の STYLE に一元管理されている。
import { Frame, isFrame } from '../../physics/frame';

export class MapToolbar {
  private readonly bar: HTMLElement;

  onDurationSelect: ((key: string) => void) | null = null;
  onFrameSelect: ((frame: Frame) => void) | null = null;
  onMapFocusSelect: ((focus: string) => void) | null = null;
  onMapViewReset: (() => void) | null = null;
  onSliderChange: ((t: number) => void) | null = null;

  constructor(root: HTMLElement) {
    this.bar = document.createElement('div');
    this.bar.id = 'hud-maptool';
    this.bar.className = 'panel';
    this.bar.innerHTML = `
      <div class="mt-row" data-id="mt-duration">
        <span class="mt-btn" data-dur="orbit">1周回</span>
        <span class="mt-btn" data-dur="day">1日</span>
        <span class="mt-btn" data-dur="week">7日</span>
        <span class="mt-btn" data-dur="month">28日</span>
        <span class="mt-btn" data-frame="inertial">慣性系</span>
        <span class="mt-btn" data-frame="sunRotating">太陽回転系</span>
      </div>
      <div class="mt-row" data-id="mt-focus">
        <span class="mt-btn" data-focus="earth">地球中心</span>
        <span class="mt-btn" data-focus="moon">月中心</span>
        <span class="mt-btn" data-id="mt-reset">視点リセット</span>
      </div>
      <input type="range" data-id="mt-slider" min="0" max="1000" value="0" />
      <div class="mt-sliderlabel" data-id="mt-sliderlabel">スライダーで未来位置を確認</div>`;
    root.appendChild(this.bar);

    this.bar.querySelectorAll<HTMLElement>('.mt-btn[data-dur]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onDurationSelect?.(btn.dataset['dur']!);
      });
    });
    this.bar.querySelectorAll<HTMLElement>('.mt-btn[data-frame]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const frame = btn.dataset['frame'];
        if (frame && isFrame(frame)) this.onFrameSelect?.(frame);
      });
    });
    this.bar.querySelectorAll<HTMLElement>('.mt-btn[data-focus]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const focus = btn.dataset['focus'];
        if (focus) this.onMapFocusSelect?.(focus);
      });
    });
    const resetBtn = this.bar.querySelector<HTMLElement>('[data-id="mt-reset"]')!;
    resetBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onMapViewReset?.();
    });
    const slider = this.bar.querySelector<HTMLInputElement>('[data-id="mt-slider"]')!;
    slider.addEventListener('pointerdown', (e) => e.stopPropagation());
    slider.addEventListener('input', () => {
      this.onSliderChange?.(Number(slider.value) / 1000);
    });
  }

  setVisible(visible: boolean): void {
    this.bar.style.display = visible ? 'block' : 'none';
  }

  // durationKey: 選択中の期間ボタン('orbit'|'day'|'week'|'month')。
  // frame: 選択中の表示座標系('inertial'|'sunRotating')。
  // sliderLabel: スライダーが 0 より大きいときに表示するラベル(T+ 表記・高度など)。
  // focus: 選択中のフォーカス('earth'|'moon')。
  setState(durationKey: string, frame: string, sliderLabel: string | null, focus: string = 'earth'): void {
    this.bar.querySelectorAll<HTMLElement>('.mt-btn[data-dur]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['dur'] === durationKey);
    });
    this.bar.querySelectorAll<HTMLElement>('.mt-btn[data-frame]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['frame'] === frame);
    });
    this.bar.querySelectorAll<HTMLElement>('.mt-btn[data-focus]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset['focus'] === focus);
    });
    const lbl = this.bar.querySelector<HTMLElement>('[data-id="mt-sliderlabel"]');
    if (lbl) lbl.textContent = sliderLabel ?? 'スライダーで未来位置を確認';
  }
}
