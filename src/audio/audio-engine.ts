// WebAudio の土台: AudioContext の生成・再開と、各音源が共有する合成素材
// (ホワイトノイズバッファ)・基本ボイス(単発トーン/ノイズバースト)を1箇所で持つ。
// ブラウザの自動再生制限のため、ctx は最初のユーザー操作での unlock() まで null。
export class AudioEngine {
  private _ctx: AudioContext | null = null;
  private _noiseBuf: AudioBuffer | null = null;

  get ctx(): AudioContext | null {
    return this._ctx;
  }

  get noiseBuf(): AudioBuffer | null {
    return this._noiseBuf;
  }

  // 実際のユーザー操作のたびに呼ぶ。AudioContext が無ければ生成し、既にあり suspended なら
  // resume する(ブラウザがタブの非アクティブ化等で後から自動停止することがあるため)。
  unlock(): void {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
      return;
    }
    try {
      this._ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this._ctx;

    // 共有ホワイトノイズバッファ
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
  }

  // 指定音高のトーンを、即時発音・指数減衰で単発鳴らす。
  tone(freq: number, duration: number, volume: number, type: OscillatorType = 'sine'): void {
    const ctx = this._ctx;
    if (!ctx) return;
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

  // 共有ノイズバッファをフィルタ・減衰させ、短いバースト音として鳴らす。
  noiseBurst(duration: number, filterType: BiquadFilterType, freq: number, volume: number): void {
    const ctx = this._ctx;
    if (!ctx || !this._noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
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
}
