// WebAudio による合成効果音(アセット不要)。
// ブラウザの自動再生制限のため、最初のユーザー操作で unlock() を呼ぶこと。
// --- 戦闘 BGM のシーケンスデータ(A マイナー系、64 ステップ = 8 小節ループ) ---
// 0 = 休符。ベースは 8 分、アルペジオは裏拍に鳴らす。
const BGM_STEP_DUR = 0.27; // 8分音符 ≈ 111 BPM
const BGM_BASS: number[] = [
  55, 0, 55, 0, 55, 0, 65.41, 0, 55, 0, 55, 0, 49, 0, 58.27, 0, // A A A C | A A G B♭
];
const BGM_PENTA = [220, 261.63, 329.63, 392, 440]; // A ペンタトニック
const BGM_PADS: number[][] = [
  [110, 164.81, 220, 261.63], // Am
  [87.31, 130.81, 174.61, 220], // F
  [98, 146.83, 196, 246.94], // G
  [110, 164.81, 220, 329.63], // Am (open)
];

export class Sfx {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private thrustGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private bgmTimer: ReturnType<typeof setInterval> | null = null;
  private bgmNextTime = 0;
  private bgmStep = 0;

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

    this.startBgm();
  }

  // ------------------------------------------------------------------ BGM
  // WebAudio 合成のループ BGM(アセット不要)。ベース + パッド + アルペジオ +
  // ノイズハットを先読みスケジューラで刻む。
  private startBgm(): void {
    if (!this.ctx || this.bgmTimer) return;
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 4); // フェードイン
    g.connect(ctx.destination);
    this.bgmGain = g;
    this.bgmNextTime = ctx.currentTime + 0.15;
    this.bgmTimer = setInterval(() => this.pumpBgm(), 120);
  }

  stopBgm(fadeSec = 2.5): void {
    if (this.bgmTimer) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    if (this.ctx && this.bgmGain) {
      this.bgmGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, fadeSec / 3);
    }
  }

  private pumpBgm(): void {
    if (!this.ctx || !this.bgmGain) return;
    // 0.5s ぶん先読みしてスケジュール(タイマー精度に依存しない)
    while (this.bgmNextTime < this.ctx.currentTime + 0.5) {
      this.scheduleBgmStep(this.bgmStep, this.bgmNextTime);
      this.bgmStep = (this.bgmStep + 1) % 64;
      this.bgmNextTime += BGM_STEP_DUR;
    }
  }

  private scheduleBgmStep(step: number, t: number): void {
    const bass = BGM_BASS[step % 16]!;
    if (bass > 0) {
      this.toneAt(bass, t, BGM_STEP_DUR * 1.8, 0.085, 'triangle', this.bgmGain!);
      this.toneAt(bass * 2, t, BGM_STEP_DUR * 0.9, 0.02, 'sawtooth', this.bgmGain!);
    }
    // パッド: 2 小節ごとにコードチェンジ
    if (step % 16 === 0) {
      for (const f of BGM_PADS[(step / 16) % BGM_PADS.length]!) {
        this.toneAt(f, t, BGM_STEP_DUR * 15, 0.016, 'triangle', this.bgmGain!, 1.2);
      }
    }
    // アルペジオ: 裏拍にペンタトニックを決定論的な疑似ランダムで
    if (step % 2 === 1 && step % 16 !== 15) {
      const f = BGM_PENTA[(step * 7 + ((step / 16) | 0) * 3) % BGM_PENTA.length]! * 2;
      this.toneAt(f, t, BGM_STEP_DUR * 0.8, 0.02, 'square', this.bgmGain!);
    }
    // ハット: 拍頭を強く
    this.noiseAt(t, 0.05, step % 8 === 0 ? 0.035 : 0.015, 7000, this.bgmGain!);
  }

  // 指定時刻に鳴らすトーン(BGM 用。attack を付けてクリックノイズを避ける)
  private toneAt(
    freq: number,
    t: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    dest: AudioNode,
    attack = 0.02,
  ): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(volume, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain).connect(dest);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  private noiseAt(t: number, duration: number, volume: number, freq: number, dest: AudioNode): void {
    if (!this.ctx || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(gain).connect(dest);
    src.start(t, Math.random() * 0.5, duration + 0.05);
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
    this.noiseBurst(0.1, 'lowpass', 900, 0.28);
    this.tone(65, 0.09, 0.18, 'square');
  }

  // 連射開始前、レールが機械的に動き出すような起動音
  spinUp(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, t);
    osc.frequency.exponentialRampToValueAtTime(320, t + 0.3);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.13, t + 0.05);
    gain.gain.setValueAtTime(0.13, t + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
    this.noiseBurst(0.3, 'bandpass', 550, 0.09);
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
