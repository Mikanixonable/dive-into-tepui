// ゲーム世界内の物体・出来事(発砲・被弾・接触・爆発・噴射など)が発する合成効果音。
// そのフレームの宣言どおりに、一回きりの音とループ音を鳴らす。
import type { AudioEngine } from '../audio-engine';
import type { SoundCue } from './sound-cue';

// 被弾点がこの距離まで自機中心から離れると、遠い被弾として音量・音高を下限にする [m]。
const HIT_SOUND_DISTANCE_MAX = 10;

const THRUST_LOOP_GAIN = 0.14;
const RCS_LOOP_GAIN = 0.035;
const ALARM_LOOP_GAIN = 0.09;

// そのフレームに鳴らすべき連続音の全体。
export interface LoopSfx {
  readonly thrust: boolean;
  readonly rcs: boolean;
}

// 一回きりの効果音の種類。hit の impactDistance は被弾点と自機中心の距離 [m]。
export type WorldSound =
  | {
    readonly kind: 'fire' | 'reload' | 'spinUp' | 'clank' | 'magFeed' | 'pickup' | 'emptyClick'
      | 'magneticInterference' | 'enemyHit' | 'explosion' | 'decouple' | 'altAlarm';
  }
  | { readonly kind: 'hit'; readonly impactDistance: number };

// そのフレームに鳴らすべき音の全体。alarm は未確認の警告が鳴っているかで、真の間だけ警報ループが鳴る。
interface WorldSfxDeclaration {
  readonly loops: LoopSfx;
  readonly alarm: boolean;
  readonly cues: readonly SoundCue<WorldSound>[];
}

// 優先順位の最も低い音(SPEC/AUDIO.md「同時に鳴る効果音の優先順位」の順位4)が、同時に鳴ってよい数。
const LOW_PRIORITY_VOICE_LIMIT = 4;

// 順位4の音が鳴っている長さの見積もり [s]。同時数を数えるためだけに使う。この表に載らない音は
// 順位1〜3で、上限によらず必ず鳴る。
const LOW_PRIORITY_SPAN: Partial<Record<WorldSound['kind'], number>> = {
  fire: 0.11,
  reload: 1.2,
  spinUp: 0.34,
  clank: 0.45,
  magFeed: 0.1,
  pickup: 0.12,
  emptyClick: 0.03,
};

export class WorldSfx {
  // 連続音のチャンネル。組めるまでと、畳んだ後は null。
  private loops: { thrust: GainNode; rcs: GainNode; alarm: GainNode } | null = null;
  // 警報ループの波形。一度組んだら使い回す。
  private klaxonBuf: AudioBuffer | null = null;
  // 畳んだ後か。立っていれば連続音の組み直しを禁じる。
  private disposed = false;
  // 組んだループ音の音源。
  private readonly loopSources: AudioBufferSourceNode[] = [];
  // 鳴らした一回きりの音のうち、最も新しい id。
  private lastCueId = -1;
  // 順位4の音が鳴り終わる見込みの時刻 [s](ctx の時刻)。上限の判定に使う。
  private lowPriorityEnds: number[] = [];

  public constructor(private readonly engine: AudioEngine) { }

  // そのフレームに鳴らすべき音の全体 declaration を受ける。一回きりの音は、まだ鳴らしていない id の
  // ものを鳴らす。上限に達した順位4の音は、鳴らさずに捨てる。
  public sync(declaration: WorldSfxDeclaration): void {
    for (const cue of declaration.cues) {
      if (cue.id <= this.lastCueId) continue;
      this.lastCueId = cue.id;
      if (!this.admit(cue.sound)) continue;
      this.play(cue.sound);
    }
    this.syncLoops(declaration.loops, declaration.alarm);
  }

  // この音を鳴らしてよいかを決める。順位4の音は、鳴っている数が上限に達していれば鳴らさない。
  // 鳴らすと決めたときは、その音が鳴り終わる時刻を数え始める。
  private admit(sound: WorldSound): boolean {
    const span = LOW_PRIORITY_SPAN[sound.kind];
    if (span === undefined) return true;
    const now = this.engine.ctx?.currentTime ?? 0;
    this.lowPriorityEnds = this.lowPriorityEnds.filter((end) => end > now);
    if (this.lowPriorityEnds.length >= LOW_PRIORITY_VOICE_LIMIT) return false;
    this.lowPriorityEnds.push(now + span);
    return true;
  }

  // 一回きりの音を1つ鳴らす。
  private play(sound: WorldSound): void {
    switch (sound.kind) {
      case 'fire': this.fire(); return;
      case 'reload': this.reload(); return;
      case 'spinUp': this.spinUp(); return;
      case 'clank': this.clank(); return;
      case 'magFeed': this.magFeed(); return;
      case 'pickup': this.pickup(); return;
      case 'emptyClick': this.emptyClick(); return;
      case 'magneticInterference': this.magneticInterference(); return;
      case 'hit': this.hit(sound.impactDistance); return;
      case 'enemyHit': this.enemyHit(); return;
      case 'explosion': this.explosion(); return;
      case 'decouple': this.decouple(); return;
      case 'altAlarm': this.altAlarm(); return;
    }
  }

  // noise を2つの帯域へ絞ったループ音を鳴らし始め、共通の音量ノードを返す。音量は 0 で始まる。
  private dualLoopChannel(ctx: AudioContext, noise: AudioBuffer,
    freq1: number, q1: number, freq2: number, q2: number): GainNode {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    for (const [freq, q] of [[freq1, q1], [freq2, q2]] as const) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = q;
      src.connect(filter).connect(gain);
      src.start();
      this.loopSources.push(src);
    }
    gain.connect(ctx.destination);
    return gain;
  }

  // ループ音を止めて切り離す。以後の宣言でループ音は鳴らず、一回きりの音は鳴る。
  public dispose(): void {
    this.disposed = true;
    for (const src of this.loopSources) {
      src.stop();
      src.disconnect();
    }
    this.loopSources.length = 0;
    this.loops?.thrust.disconnect();
    this.loops?.rcs.disconnect();
    this.loops?.alarm.disconnect();
    this.loops = null;
  }

  // 艦砲 CIWS 風の砲声1発ぶん: 低く重い胴鳴り + 鋭いクラック。連射は断続的に聞こえる(SPEC/AUDIO.md「機関砲」)。
  private fire(): void {
    this.engine.noiseBurst(0.11, 'lowpass', 480, 0.4);
    this.engine.noiseBurst(0.025, 'highpass', 2600, 0.09);
    this.engine.tone(48, 0.1, 0.2, 'square');
    this.engine.tone(96, 0.05, 0.07, 'sawtooth');
  }

  // リロード音「ガチャッ、シャコォォン」。
  private reload(): void {
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
  private spinUp(): void {
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

  // 薬莢が機体に当たったときの、重い金属の筒の接触音。乾いた衝撃 + FM のクラン + 乱暴な高倍音 +
  // 艦体を伝わる低い共鳴で構成する(SPEC/AUDIO.md「被弾・衝突・爆発」)。
  private clank(): void {
    const ctx = this.engine.ctx;
    const noise = this.engine.noiseBuf;
    if (!ctx || !noise) return;
    const t = ctx.currentTime;
    // 艦砲クラスの薬莢の基本共鳴付近。個体差を大きめに。
    const f0 = 430 * (1 + (Math.random() * 2 - 1) * 0.18);
    // 接触位置が左右にばらけるだけの定位差。
    const dest = ctx.createStereoPanner();
    dest.pan.value = (Math.random() * 2 - 1) * 0.6;
    dest.connect(ctx.destination);

    const noiseAt = (t0: number, dur: number, type: BiquadFilterType, freq: number, q: number, vol: number): void => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(freq, t0);
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      src.connect(filter).connect(gain).connect(dest);
      src.start(t0, Math.random() * 0.5, dur + 0.02);
      src.stop(t0 + dur + 0.05);
    };
    const partial = (t0: number, freq: number, dur: number, vol: number): void => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      osc.connect(gain).connect(dest);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    };
    // 変調波でキャリアを揺らし、非整数側帯を一括で出す金属音。index は鳴きと一緒に減る。
    const fmClang = (t0: number, fc: number, ratio: number, index: number, dur: number, vol: number): void => {
      const carrier = ctx.createOscillator();
      carrier.frequency.setValueAtTime(fc, t0);
      const mod = ctx.createOscillator();
      mod.frequency.setValueAtTime(fc * ratio, t0);
      const modIndex = ctx.createGain();
      modIndex.gain.setValueAtTime(fc * index, t0);
      modIndex.gain.exponentialRampToValueAtTime(1, t0 + dur * 0.8);
      mod.connect(modIndex).connect(carrier.frequency);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      carrier.connect(gain).connect(dest);
      mod.start(t0);
      carrier.start(t0);
      mod.stop(t0 + dur + 0.02);
      carrier.stop(t0 + dur + 0.02);
    };

    // 乾いた衝撃: 低域の鈍い当たり + 縁の高域エッジ。
    noiseAt(t, 0.014, 'lowpass', 500, 1, 0.18);
    noiseAt(t, 0.004, 'highpass', 5200, 0.8, 0.08);
    // FM のクラン 3 層: 胴の鳴き・中域の金属・高域のエッジ。
    fmClang(t, f0, 1.02, 2, 0.25, 0.07);
    fmClang(t, f0 * 2.76, 1.37, 3, 0.14, 0.042);
    fmClang(t, f0 * 5.4, 1.99, 1.8, 0.07, 0.021);
    // 乱暴な高倍音: 大きな金属が当たる非整数の高次モード(6.7〜13.7倍)と擦れのキンキン。
    [6.7, 8.9, 11.3, 13.7].forEach((m, k) => {
      partial(t, f0 * m * (1 + (Math.random() * 2 - 1) * 0.08), 0.05 + Math.random() * 0.05, 0.032 / (1 + k * 0.5));
    });
    noiseAt(t, 0.04, 'bandpass', 5200 * (1 + (Math.random() * 2 - 1) * 0.25), 4, 0.06);
    // 高域の粒: 擦れ合う金属のビリビリ。
    const grains = 4 + Math.floor(Math.random() * 4);
    for (let i = 0; i < grains; i++) {
      noiseAt(t + Math.random() * 0.015, 0.005, 'bandpass', 4500 * (1 + (Math.random() * 2 - 1) * 0.5), 5, 0.056);
    }
    // 艦体を伝わる低い共鳴。
    noiseAt(t + 0.01, 0.4, 'bandpass', 280 * (1 + (Math.random() * 2 - 1) * 0.15), 3, 0.063);
    partial(t + 0.01, 190 * (1 + (Math.random() * 2 - 1) * 0.1), 0.3, 0.035);
  }

  // マガジン給弾(次のマガジンが取り込まれるガチャッという機械音)
  private magFeed(): void {
    this.engine.noiseBurst(0.1, 'lowpass', 500, 0.14);
    this.engine.tone(140, 0.07, 0.08, 'square');
    this.engine.noiseBurst(0.05, 'highpass', 3000, 0.04);
  }

  // 補給マガジンの取り込み(くぐもった肯定の2音と、遠くで鳴るチャイム)
  private pickup(): void {
    this.engine.tone(220, 0.12, 0.1, 'triangle');
    this.engine.tone(330, 0.14, 0.08, 'triangle', 0.1);
    this.engine.tone(1320, 0.25, 0.03, 'sine', 0.18);
  }

  // 弾切れの空撃ちクリック
  private emptyClick(): void {
    this.engine.tone(1400, 0.03, 0.05, 'square');
    this.engine.noiseBurst(0.02, 'highpass', 4000, 0.03);
  }

  // 弾が至近を通過したときの磁気干渉音。低い唸りをパルス状に断続させ、
  // そのまわりにプラズマの筋を思わせる小さな唸りを不規則に散らす。
  private magneticInterference(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;

    // 主発: 低い唸りが持ち上がってから沈む。矩形波のゲートで断続させる。
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(60 * (1 + (Math.random() * 2 - 1) * 0.04), t);
    osc.frequency.exponentialRampToValueAtTime(80 * (1 + (Math.random() * 2 - 1) * 0.04), t + 0.14);
    osc.frequency.exponentialRampToValueAtTime(42 * (1 + (Math.random() * 2 - 1) * 0.04), t + 0.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(100, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.1);
    filter.frequency.exponentialRampToValueAtTime(100, t + 0.3);

    const gate = ctx.createGain();
    gate.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 22 * (1 + (Math.random() * 2 - 1) * 0.25);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.08;
    const gateBias = ctx.createConstantSource();
    gateBias.offset.value = 0.07;
    lfo.connect(lfoDepth).connect(gate.gain);
    gateBias.connect(gate.gain);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(1, t + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);

    osc.connect(filter).connect(gate).connect(gain).connect(ctx.destination);
    for (const node of [osc, lfo, gateBias]) {
      node.start(t);
      node.stop(t + 0.45);
    }

    // フィラメント: 本体の周囲を不規則に通り過ぎる小さな唸り。
    let ft = t + 0.05;
    const filamentCount = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < filamentCount; i++) {
      ft += 0.04 + Math.random() * 0.06;
      const fLow = 55 + Math.random() * 40;
      const fOsc = ctx.createOscillator();
      fOsc.type = Math.random() < 0.5 ? 'triangle' : 'sawtooth';
      fOsc.frequency.setValueAtTime(fLow, ft);
      fOsc.frequency.exponentialRampToValueAtTime(fLow * (1.2 + Math.random() * 0.3), ft + 0.1);
      fOsc.frequency.exponentialRampToValueAtTime(fLow * 0.7, ft + 0.2);
      const fFilter = ctx.createBiquadFilter();
      fFilter.type = 'lowpass';
      fFilter.frequency.value = 350;
      const fGain = ctx.createGain();
      const fDur = 0.18 + Math.random() * 0.1;
      fGain.gain.setValueAtTime(0.001, ft);
      fGain.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, ft + fDur * 0.4);
      fGain.gain.exponentialRampToValueAtTime(0.001, ft + fDur);
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.7;
      fOsc.connect(fFilter).connect(fGain).connect(pan).connect(ctx.destination);
      fOsc.start(ft);
      fOsc.stop(ft + fDur + 0.05);
    }
  }

  // 自機被弾音。被弾点が自機中心から遠いほど、音量と音高を下げる。
  private hit(impactDistance: number): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // 近さ 0〜1(1 が自機中心)から、音高と音量を決める。
    const proximity = Math.max(0, Math.min(1, 1 - impactDistance / HIT_SOUND_DISTANCE_MAX));
    const frequency = 80 + 90 * proximity;
    const peakGain = 0.2 + 0.7 * proximity;
    const tailGain = 0.02 + 0.08 * proximity;

    // ノコギリ波をローパスで鈍らせた、短い打撃音。
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
  private enemyHit(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // 和音全体が通る、一瞬開いて閉じるローパスと減衰。
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(520, t + 0.08);
    filter.frequency.exponentialRampToValueAtTime(130, t + 0.3);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    // 3音の和音。どの音も音高が沈んでいく。
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
  private explosion(): void {
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
  private decouple(): void {
    this.engine.noiseBurst(0.055, 'highpass', 1800, 0.16);
    this.engine.noiseBurst(0.09, 'lowpass', 320, 0.22);
    this.engine.tone(760, 0.06, 0.07, 'square');
    this.engine.tone(430, 0.11, 0.05, 'triangle');
  }

  // 高度低下警報: 短い二音の警告音。
  private altAlarm(): void {
    this.engine.tone(392, 0.16, 0.09, 'square');
    this.engine.tone(415.3, 0.16, 0.07, 'square'); // わずかに不協和にして警報らしいうなりを出す
  }

  // 連続音の宣言へ、各チャンネルの音量をなめらかに追わせる。
  private syncLoops(loops: LoopSfx, alarm: boolean): void {
    const ctx = this.engine.ctx;
    const channels = this.ensureLoops();
    if (!ctx || channels === null) return;
    channels.thrust.gain.setTargetAtTime(loops.thrust ? THRUST_LOOP_GAIN : 0, ctx.currentTime, 0.04);
    channels.rcs.gain.setTargetAtTime(loops.rcs ? RCS_LOOP_GAIN : 0, ctx.currentTime, 0.03);
    channels.alarm.gain.setTargetAtTime(alarm ? ALARM_LOOP_GAIN : 0, ctx.currentTime, 0.08);
  }

  // 連続音のチャンネルを、無ければ組んで返す。ctx が開く前と、畳んだ後は null。
  private ensureLoops(): { thrust: GainNode; rcs: GainNode; alarm: GainNode } | null {
    if (this.loops !== null || this.disposed) return this.loops;
    const ctx = this.engine.ctx;
    const noise = this.engine.noiseBuf;
    if (!ctx || !noise) return null;
    this.loops = {
      thrust: this.dualLoopChannel(ctx, noise, 140, 0.6, 50, 1.0),
      rcs: this.dualLoopChannel(ctx, noise, 650, 1.0, 200, 1.5),
      alarm: this.alarmLoopChannel(ctx),
    };
    return this.loops;
  }

  // 警報ループを鳴らし始め、その音量ノードを返す。音量は 0 で始まり、音源は dispose まで鳴り続ける。
  private alarmLoopChannel(ctx: AudioContext): GainNode {
    const src = ctx.createBufferSource();
    src.buffer = this.klaxonBuffer(ctx);
    src.loop = true;
    src.playbackRate.value = 1.2;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.loopSources.push(src);
    return gain;
  }

  // 警報音の波形: 高い音と低い音の2ビープを 1 秒周期で繰り返すクラクション。
  private klaxonBuffer(ctx: AudioContext): AudioBuffer {
    if (this.klaxonBuf !== null) return this.klaxonBuf;
    const seconds = 1;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    // ビープの両端をわずかにフェードして、パルスのクリックを防ぐ。
    const beep = (from: number, to: number, frequency: number): void => {
      const i0 = Math.floor(from * ctx.sampleRate);
      const i1 = Math.floor(to * ctx.sampleRate);
      const fade = Math.floor(ctx.sampleRate * 0.004);
      for (let i = i0; i < i1; i++) {
        const square = (i * frequency * 2 / ctx.sampleRate) % 2 < 1 ? 1 : -1;
        data[i] = square * Math.min(1, (i - i0) / fade, (i1 - i) / fade);
      }
    };
    beep(0, 0.18, 880);
    beep(0.3, 0.48, 587);
    this.klaxonBuf = buf;
    return buf;
  }
}
