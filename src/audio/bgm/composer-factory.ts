// トラックの kind と Composer の実装を結びつける唯一の場所。ここに分岐が集まっているので、
// Composer を増やしても再生側(bgm.ts)は変わらない。
import { BgmTrack } from './tracks/types';
import { Composer } from './composer';
import { PhasingComposer } from './composers/phasing-composer';
import { AntipodeComposer } from './composers/antipode-composer';
import { SuiteComposer } from './composers/suite-composer';

// トラックの kind から、そのパラメータを消費する Composer を組む。
// kind を増やしたらここへ分岐を足す — 足し忘れは default の never 代入がコンパイルエラーにする。
export function createComposer(track: BgmTrack): Composer {
  // kind ごとに params の型が違い、この switch が narrowing の役目も果たす。
  switch (track.kind) {
    case 'phasing':
      return new PhasingComposer(track.params);
    case 'antipode':
      return new AntipodeComposer(track.params);
    case 'suite':
      return new SuiteComposer(track.params);
    default: {
      const unknown: never = track;
      throw new Error(`unknown BGM track kind: ${JSON.stringify(unknown)}`);
    }
  }
}
