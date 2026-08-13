// HP/温度/電力などのバー。バーは常に左から右へ満ちる。危険域の色は theme.ts の DANGER 色。
export class Meter {
  readonly element: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly valueEl: HTMLElement;

  // 地(track)・満ち幅(fill)・重ねる数値表示(valueEl)の3層を組む。
  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'w-meter';
    const track = document.createElement('div');
    track.className = 'w-meter-track';
    this.fill = document.createElement('div');
    this.fill.className = 'w-meter-fill';
    this.valueEl = document.createElement('div');
    this.valueEl.className = 'w-meter-value';
    // fill と valueEl は同じ track に重ねる — fill が満ち幅、valueEl がその上の数値表示。
    track.appendChild(this.fill);
    track.appendChild(this.valueEl);
    this.element.appendChild(track);
  }

  // ratio は 0..1 にクランプして満ち幅へ反映する。
  setRatio(ratio: number): void {
    this.fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  setDanger(danger: boolean): void {
    this.fill.classList.toggle('danger', danger);
  }

  // バーの上に重ねる数値表示(例: "1234 / 5000")を設定する。
  setLabel(label: string): void {
    this.valueEl.textContent = label;
  }
}
