import { applyAlarmLevel, type AlarmLevel } from '../alarm-level';

// HP/温度/電力などの細い線のバー。常に左から右へ満ちる。量は中立の線で示し、注意域・警告域の
// 閾値を目盛りで示す。塗りが注意色・警告色になるのは、呼び出し側が段を渡したときだけ。
export class Meter {
  public readonly element: HTMLElement;
  // progressbar の aria 属性を書く対象のトラック。
  public readonly track: HTMLElement;
  private readonly fill: HTMLElement;
  private valueEl: HTMLElement | null = null;
  private level: AlarmLevel = 'normal';

  // 地(track)・満ち幅(fill)の2層を組む。線の脇の数値表示は、初めて setLabel を呼んだ時点で
  // だけ作る — 右寄せの数値を別要素で持つ場面では表示層を持たせない。
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

  // 注意・警告の閾値の位置(0..1)へ目盛りを立てる。持たない段は null。呼び直すと立て直す。
  public setMarks(cautionRatio: number | null, warningRatio: number | null): void {
    this.track.querySelectorAll('.w-meter-mark').forEach((mark) => mark.remove());
    for (const ratio of [cautionRatio, warningRatio]) {
      if (ratio === null) continue;
      const mark = document.createElement('div');
      mark.className = 'w-meter-mark';
      mark.style.setProperty('--at', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
      this.track.appendChild(mark);
    }
  }

  // 満ちた部分と数値表示の色を、段に合わせて切り替える。normal は中立。
  public setLevel(level: AlarmLevel): void {
    this.level = level;
    this.fill.classList.toggle('caution', level === 'caution');
    this.fill.classList.toggle('warning', level === 'warning');
    if (this.valueEl !== null) applyAlarmLevel(this.valueEl, level);
  }

  // 線の脇に置く数値表示(例: "1234 / 5000")を設定する。
  public setLabel(label: string): void {
    if (this.valueEl === null) {
      this.valueEl = document.createElement('div');
      this.valueEl.className = 'w-meter-value';
      applyAlarmLevel(this.valueEl, this.level);
      this.element.appendChild(this.valueEl);
    }
    this.valueEl.textContent = label;
  }

  // 満ち幅・段・progressbar の aria をまとめて反映する。now/max の単位と
  // 段の判定は呼び出し側が決める。valueText に null を渡せば valuetext を持たない。
  public setProgress(now: number, max: number, valueText: string | null, level: AlarmLevel): void {
    this.setRatio(max > 0 ? now / max : 0);
    this.setLevel(level);
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
