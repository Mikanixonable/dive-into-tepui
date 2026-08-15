// 発振器1つを立ち上がり~指数減衰の包絡で鳴らすだけの、いちばん素朴な楽器。
// 定位(pan)だけは曲の間ずっと要るので、パンナーはコンストラクタで組んで使い回す。
import { ToneParams } from '../tracks/types';
import { Instrument } from '../instrument';

// 減衰の到達値。0 へは指数で近づけないので、聞こえない程度の小さな値で止める。
const DECAY_FLOOR = 0.001;
// 立ち上がりの開始値。ここも 0 にできないため。
const SILENCE = 0.0001;

export class ToneInstrument implements Instrument {
  private readonly output: AudioNode;

  // destination は再生側のゲイン。定位はここで一度組んで曲の間ずっと使う。
  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly params: ToneParams,
  ) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = params.pan;
    panner.connect(destination);
    this.output = panner;
  }

  // when から鳴らす。時刻はすべて引数から導き、ctx.currentTime は読まない。
  play(freq: number, when: number, durationSec: number, velocity: number): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = this.params.wave;
    osc.frequency.value = freq;
    // 立ち上がり~減衰のゲイン包絡を組み、クリックノイズを避ける
    const env = ctx.createGain();
    env.gain.setValueAtTime(SILENCE, when);
    env.gain.linearRampToValueAtTime(velocity * this.params.level, when + this.params.attackSec);
    env.gain.exponentialRampToValueAtTime(DECAY_FLOOR, when + durationSec);
    osc.connect(env).connect(this.output);
    osc.start(when);
    osc.stop(when + durationSec + 0.05);
  }
}
