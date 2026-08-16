// 楽器宣言の kind と Instrument の実装を結びつける唯一の場所。ここに分岐が集まっているので、
// 楽器を増やしても再生側(track-playback.ts)は変わらない。
import { InstrumentDef } from './instruments/types';
import { Instrument } from './instrument';
import { ToneInstrument } from './instruments/tone-instrument';
import { UnisonInstrument } from './instruments/unison-instrument';

// 宣言どおりの楽器を組み、出音を destination へ繋ぐ。
// kind を増やしたらここへ分岐を足す — 足し忘れは default の never 代入がコンパイルエラーにする。
export function createInstrument(def: InstrumentDef, ctx: AudioContext, destination: AudioNode): Instrument {
  // kind ごとに params の型が違い、この switch が narrowing の役目も果たす。
  switch (def.kind) {
    case 'tone':
      return new ToneInstrument(ctx, destination, def.params);
    case 'unison':
      return new UnisonInstrument(ctx, destination, def.params);
    default: {
      const unknown: never = def;
      throw new Error(`unknown BGM instrument kind: ${JSON.stringify(unknown)}`);
    }
  }
}
