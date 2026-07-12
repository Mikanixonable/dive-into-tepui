// WebAudio による合成効果音(アセット不要)。
// ブラウザの自動再生制限のため、最初のユーザー操作で unlock() を呼ぶこと。
export class Sfx {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private thrustGain: GainNode | null = null;

  unlock(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;

    // 共有ホワイトノイズバッファ
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // スラスタ噴射のループ音(通常は無音)
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.thrustGain = gain;
  }

  private noiseBurst(duration: number, filterType: BiquadFilterType, freq: number, volume: number): void {
    if (!this.ctx || !this.noiseBuf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t, Math.random() * 0.5, duration + 0.05);
  }

  private tone(freq: number, duration: number, volume: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration);
  }

  fire(): void {
    this.noiseBurst(0.09, 'highpass', 1800, 0.22);
    this.tone(150, 0.06, 0.12, 'square');
  }

  hit(): void {
    this.tone(1500 + Math.random() * 500, 0.08, 0.15, 'triangle');
  }

  explosion(): void {
    this.noiseBurst(0.9, 'lowpass', 350, 0.5);
    this.tone(70, 0.5, 0.25, 'sine');
  }

  warp(): void {
    this.tone(660, 0.06, 0.08, 'sine');
  }

  setThrust(on: boolean): void {
    if (!this.ctx || !this.thrustGain) return;
    const target = on ? 0.1 : 0;
    this.thrustGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
  }
}
