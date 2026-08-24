// ゲーム世界内の物体・出来事(発砲・被弾・接触・爆発・噴射など)が発する合成効果音
// (アセット不要)。AudioEngine が共有する素材(ノイズバッファ・基本ボイス)と、ここで組む
// 専用のオシレータ/フィルタで、単発音とループ音を鳴らす。
// AudioContext が unlock されるまでは、どのメソッドも無音のまま何もしない。
import { AudioEngine } from '../audio-engine';

// 被弾点がこの距離まで自機中心から離れると、遠い被弾として音量・音高を下限にする [m]。
const HIT_SOUND_DISTANCE_MAX = 10;

export class WorldSfx {
  private thrustGain: GainNode | null = null;
  private rcsGain: GainNode | null = null;

  constructor(private readonly engine: AudioEngine) { }

  // 常時再生のループ音チャンネル(通常は無音)を組む。ctx が未生成のうちは null を返し、
  // 呼び出し側は次の機会にまた組み直しを試みる。
  private loopChannel(freq: number, q: number): GainNode | null {
    const ctx = this.engine.ctx;
    const noise = this.engine.noiseBuf;
    if (!ctx || !noise) return null;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    return gain;
  }

  // 艦砲 CIWS 風の砲声: 低く重い胴鳴り + 鋭いクラック。
  // 実物のように連続音にはせず、1 発ずつ聞こえる離散的な発砲音のまま。
  fire(): void {
    this.engine.noiseBurst(0.11, 'lowpass', 480, 0.4);
    this.engine.noiseBurst(0.025, 'highpass', 2600, 0.09);
    this.engine.tone(48, 0.1, 0.2, 'square');
    this.engine.tone(96, 0.05, 0.07, 'sawtooth');
  }

  // リロード音: 金属質のノイズと金属音を組み合わせて「ガチャッ、シャコォォン」という音を作る
  playReload(): void {
    const ctx = this.engine.ctx;
    const noise = this.engine.noiseBuf;
    if (!ctx || !noise) return;
    const t = ctx.currentTime;

    // スライドする金属的なノイズ
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1500, t);
    filter.frequency.exponentialRampToValueAtTime(300, t + 1.2);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.005, t + 1.2);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t, 0, 1.2);

    // バレル排出・交換時の甲高い金属音
    this.engine.tone(1200, 0.1, 0.05, 'square');
    this.engine.tone(800, 0.15, 0.05, 'sawtooth');
  }

  // 連射開始前の起動音: 艦砲 CIWS のモーターが立ち上がる唸りに似せる。
  // 低い三角波の唸りが滑り上がり、機械的なこすれノイズが重なる。
  spinUp(): void {
    const ctx = this.engine.ctx;
    const noise = this.engine.noiseBuf;
    if (!ctx || !noise) return;
    const t = ctx.currentTime;

    // モーターの唸り(基音 + 3 倍音、周波数が立ち上がる)
    const whine = ctx.createOscillator();
    whine.type = 'triangle';
    whine.frequency.setValueAtTime(50, t);
    whine.frequency.exponentialRampToValueAtTime(205, t + 0.3);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.linearRampToValueAtTime(0.09, t + 0.08);
    wg.gain.setValueAtTime(0.09, t + 0.24);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    whine.connect(wg).connect(ctx.destination);
    whine.start(t);
    whine.stop(t + 0.34);

    const harm = ctx.createOscillator();
    harm.type = 'sawtooth';
    harm.frequency.setValueAtTime(150, t);
    harm.frequency.exponentialRampToValueAtTime(615, t + 0.3);
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.linearRampToValueAtTime(0.022, t + 0.1);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    harm.connect(hg).connect(ctx.destination);
    harm.start(t);
    harm.stop(t + 0.34);

    // 機械のこすれ(バンドパスノイズ、周波数が滑り上がる)
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(260, t);
    bp.frequency.exponentialRampToValueAtTime(1150, t + 0.28);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t, Math.random() * 0.4, 0.35);
  }

  // 薬莢が機体に当たったときの、からんとした金属音(かすかに)
  clank(): void {
    const f0 = 1800 + Math.random() * 1600;
    this.engine.tone(f0, 0.05, 0.035, 'triangle');
    this.engine.tone(f0 * 1.53, 0.04, 0.02, 'triangle'); // 非整数倍音で金属感
    this.engine.noiseBurst(0.03, 'highpass', 5000, 0.02);
  }

  // マガジン給弾(次のマガジンが取り込まれるガチャッという機械音)
  magFeed(): void {
    this.engine.noiseBurst(0.1, 'lowpass', 500, 0.14);
    this.engine.tone(140, 0.07, 0.08, 'square');
    this.engine.noiseBurst(0.05, 'highpass', 3000, 0.04);
  }

  // 補給マガジンの取り込み(肯定的なブリップ)
  pickup(): void {
    this.engine.tone(660, 0.09, 0.09, 'sine');
    this.engine.tone(990, 0.12, 0.07, 'sine');
    this.engine.noiseBurst(0.08, 'lowpass', 600, 0.06);
  }

  // 弾切れの空撃ちクリック
  emptyClick(): void {
    this.engine.tone(1400, 0.03, 0.05, 'square');
    this.engine.noiseBurst(0.02, 'highpass', 4000, 0.03);
  }

  // 弾が至近を通過したときの「ヴン」という磁気干渉音
  magneticInterference(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';

    osc.frequency.setValueAtTime(60, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.3);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(100, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.1);
    filter.frequency.exponentialRampToValueAtTime(100, t + 0.3);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  }

  // 自機被弾音。被弾点が自機中心から遠いほど、音量と音高を下げる。
  hit(impactDistance: number): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const proximity = Math.max(0, Math.min(1, 1 - impactDistance / HIT_SOUND_DISTANCE_MAX));
    const frequency = 80 + 90 * proximity;
    const peakGain = 0.2 + 0.7 * proximity;
    const tailGain = 0.02 + 0.08 * proximity;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(frequency, t);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(70, t);
    filter.frequency.exponentialRampToValueAtTime(190, t + 0.1);
    filter.frequency.exponentialRampToValueAtTime(55, t + 0.32);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peakGain, t);
    gain.gain.exponentialRampToValueAtTime(tailGain, t + 0.35);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.38);
  }

  // 敵機被弾時のノコギリ波ローパス和音
  enemyHit(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(520, t + 0.08);
    filter.frequency.exponentialRampToValueAtTime(130, t + 0.3);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    [110, 138, 165].forEach((frequency) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(frequency, t);
      osc.frequency.exponentialRampToValueAtTime(frequency * 0.72, t + 0.26);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + 0.35);
    });
    filter.connect(gain).connect(ctx.destination);
  }

  // 撃破爆発音
  explosion(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // 鈍い破裂音
    this.engine.noiseBurst(0.2, 'lowpass', 150, 0.8);
    this.engine.noiseBurst(0.1, 'lowpass', 400, 0.5);

    // 短い低音のキックのような成分
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(30, t + 0.15);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.8, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // デカプラーの爆砕ボルト。撃破爆発より短い破裂音と金属の解放音を重ねる。
  decouple(): void {
    this.engine.noiseBurst(0.055, 'highpass', 1800, 0.16);
    this.engine.noiseBurst(0.09, 'lowpass', 320, 0.22);
    this.engine.tone(760, 0.06, 0.07, 'square');
    this.engine.tone(430, 0.11, 0.05, 'triangle');
  }

  // 高度低下警報: 短い二音の警告音(熱防御警報よりは緊急度の低いトーン)
  altAlarm(): void {
    this.engine.tone(392, 0.16, 0.09, 'square');
    this.engine.tone(415.3, 0.16, 0.07, 'square'); // わずかに不協和にして警報らしいうなりを出す
  }

  // メインエンジンのループ音量をなめらかに on/off する。
  setThrust(on: boolean): void {
    this.thrustGain ??= this.loopChannel(320, 0.8);
    const ctx = this.engine.ctx;
    if (!ctx || !this.thrustGain) return;
    this.thrustGain.gain.setTargetAtTime(on ? 0.1 : 0, ctx.currentTime, 0.04);
  }

  // RCS スラスタのループ音量をなめらかに on/off する(メインエンジンより高く軽いシュー音)。
  setRcs(on: boolean): void {
    this.rcsGain ??= this.loopChannel(1600, 1.1);
    const ctx = this.engine.ctx;
    if (!ctx || !this.rcsGain) return;
    this.rcsGain.gain.setTargetAtTime(on ? 0.015 : 0, ctx.currentTime, 0.03);
  }
}
