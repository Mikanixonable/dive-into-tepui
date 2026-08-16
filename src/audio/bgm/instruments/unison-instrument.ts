// 同じ音程を少しずつずらした発振器を重ねて厚みを出す楽器。ずれた成分どうしが干渉して
// ゆっくりしたうねりになる。
// フィルタと定位は音符ごとに変わらないので、コンストラクタで組んで曲の間ずっと使い回す。
import { UnisonParams } from './types';
import { Instrument } from '../instrument';

// 減衰の到達値。0 へは指数で近づけないので、聞こえない程度の小さな値で止める。
const DECAY_FLOOR = 0.001;
// 立ち上がりの開始値。ここも 0 にできないため。
const SILENCE = 0.0001;

export class UnisonInstrument implements Instrument {
  private readonly input: AudioNode;
  private readonly filter: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  // 各 voice のデチューン量[cent]。音程によらないのでここで一度だけ配っておく。
  private readonly detunes: number[];

  // destination は再生側のゲイン。
  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly params: UnisonParams,
  ) {
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = params.pan;
    this.filter = new BiquadFilterNode(ctx, params.filterOptions);
    this.filter.connect(this.panner).connect(destination);
    this.input = this.filter;
    this.detunes = spreadDetune(params.voices, params.detuneCents);
  }

  // when から鳴らす。時刻はすべて引数から導き、ctx.currentTime は読まない。
  play(freq: number, when: number, durationSec: number, velocity: number): void {
    const ctx = this.ctx;
    // 重ねたぶん振幅が積み上がるので、voice 数で割って level の意味を保つ。
    const peak = (velocity * this.params.level) / this.detunes.length;
    // 立ち上がり~減衰のゲイン包絡を組み、クリックノイズを避ける
    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENCE, when);
    env.gain.linearRampToValueAtTime(peak, when + this.params.attackSec);
    env.gain.exponentialRampToValueAtTime(DECAY_FLOOR, when + durationSec);
    env.connect(this.input);

    for (const detune of this.detunes) {
      const osc = ctx.createOscillator();
      osc.type = this.params.wave;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(env);
      osc.start(when);
      osc.stop(when + durationSec + 0.05);
    }
  }

  // フィルタと定位を音声グラフから外す。
  dispose(): void {
    this.filter.disconnect();
    this.panner.disconnect();
  }
}

// voice 数ぶんのデチューン量を、0 を中心に ±cents へ均等に配る。
// 1声なら 0 のみ。偶数声では中央に素の音程が立たず、うなりだけが残る。
function spreadDetune(voices: number, cents: number): number[] {
  const count = Math.max(1, Math.floor(voices));
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, i) => -cents + (2 * cents * i) / (count - 1));
}
