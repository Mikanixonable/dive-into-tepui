// HP/温度/電力などのバー。バーは常に左から右へ満ちる。危険域の色は theme.ts の DANGER 色。
export class Meter {
  public readonly element: HTMLElement;
  // progressbar の aria 属性を書く対象のトラック。
  public readonly track: HTMLElement;
  private readonly fill: HTMLElement;
  private valueEl: HTMLElement | null = null;

  // 地(track)・満ち幅(fill)の2層を組む。バーの上へ重ねる数値表示は、初めて setLabel を
  // 呼んだ時点でだけ作る — 右寄せの数値を別要素で持つ場面では表示層を持たせない。
  // label は読み上げ名(aria-label)。
  public constructor(label?: string) {
    this.element = document.createElement('div');
    this.element.className = 'w-meter';
    // トラック自体が progressbar — 値の aria はここへ書く。
    this.track = document.createElement('div');
    this.track.className = 'w-meter-track';
    this.track.setAttribute('role', 'progressbar');
    if (label !== undefined) this.track.setAttribute('aria-label', label);
    this.fill = document.createElement('div');
    this.fill.className = 'w-meter-fill';
    this.track.appendChild(this.fill);
    this.element.appendChild(this.track);
  }

  // ratio は 0..1 にクランプして満ち幅へ反映する。
  public setRatio(ratio: number): void {
    this.fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  }

  // 満ちた部分の色を危険色へ切り替える。
  public setDanger(danger: boolean): void {
    this.fill.classList.toggle('danger', danger);
  }

  // バーの上に重ねる数値表示(例: "1234 / 5000")を設定する。
  public setLabel(label: string): void {
    if (this.valueEl === null) {
      this.valueEl = document.createElement('div');
      this.valueEl.className = 'w-meter-value';
      this.track.appendChild(this.valueEl);
    }
    this.valueEl.textContent = label;
  }

  // 満ち幅・危険色・progressbar の aria をまとめて反映する。now/max の単位と
  // 危険域の境界は呼び出し側が決める。valueText に null を渡せば valuetext を持たない。
  public setProgress(now: number, max: number, valueText: string | null, danger: boolean): void {
    this.setRatio(max > 0 ? now / max : 0);
    this.setDanger(danger);
    // progressbar の読み上げ値を見た目の値と揃える。
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', String(max));
    this.track.setAttribute('aria-valuenow', String(now));
    if (valueText === null) {
      this.track.removeAttribute('aria-valuetext');
    } else {
      this.track.setAttribute('aria-valuetext', valueText);
    }
  }
}
