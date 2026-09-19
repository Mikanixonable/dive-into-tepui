// WebAudio の土台: AudioContext の生成・再開と、各音源が共有する合成素材
// (ホワイトノイズバッファ)・基本ボイス(単発トーン/ノイズバースト)を1箇所で持つ。
// ブラウザの制約 — 自動再生できないことと、非表示のタブで鳴らさないこと — はここで引き受け、
// 外へは見せない。ctx は最初のユーザー操作まで null で、その間どの音源も無音のまま何もしない。
export class AudioEngine {
  private _ctx: AudioContext | null = null;
  private _noiseBuf: AudioBuffer | null = null;
  // ctx が開くのを待っている購読。開いた時点で呼び切って捨てる。
  private readonly pending: (() => void)[] = [];

  // 最初のユーザー操作を自分で待つ。capture 段階で聞くので、ボタンの click ハンドラが
  // その場で鳴らす音(設定画面の試聴)にも間に合う。
  constructor() {
    const open = (): void => {
      document.removeEventListener('pointerdown', open, true);
      document.removeEventListener('keydown', open, true);
      this.openContext();
    };
    document.addEventListener('pointerdown', open, true);
    document.addEventListener('keydown', open, true);
    document.addEventListener('visibilitychange', () => this.syncSuspension());
  }

  get ctx(): AudioContext | null {
    return this._ctx;
  }

  get noiseBuf(): AudioBuffer | null {
    return this._noiseBuf;
  }

  // ctx が開いたときに一度だけ呼ぶ購読。すでに開いていれば即座に呼ぶ。開くまで鳴らせない
  // 音源が、開いた時点で自分の宣言を鳴らし直すために使う。
  whenUnlocked(listener: () => void): void {
    if (this._ctx) listener();
    else this.pending.push(listener);
  }

  // AudioContext と共有ホワイトノイズバッファを組む。ユーザー操作の中でしか呼ばない。
  private openContext(): void {
    try {
      this._ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this._ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    this.syncSuspension();
    for (const listener of this.pending) listener();
    this.pending.length = 0;
  }

  // タブが見えているあいだだけ ctx を進める。止めているあいだは currentTime も進まないので、
  // 先読みで組み立てる音楽は、表示に戻ると止まった位置から続く。
  private syncSuspension(): void {
    const ctx = this._ctx;
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
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
