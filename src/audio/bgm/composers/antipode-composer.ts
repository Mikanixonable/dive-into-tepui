// 2つ目の作曲アルゴリズム。一定ステップごとに和音を短く打ち込む。
// 移調と和音の進行は別々の間隔で進むので、周期が食い違うぶんだけ組み合わせが移り変わる —
// 同じ和音が違う高さで、同じ高さに違う和音が来る。音階・和音・間隔は AntipodeParams が持つ。
import { AntipodeParams } from '../tracks/types';
import { Composer, ComposerNote } from '../composer';
import { cycleAt, phaseValue, scaleFreq } from './utils';

export class AntipodeComposer implements Composer {
  constructor(private readonly params: AntipodeParams) {}

  get stepDurSec(): number {
    return this.params.stepDur;
  }

  // このステップが打ち込みの位置なら、そのとき選ばれている和音を移調して返す。
  notesAt(step: number): ComposerNote[] {
    const { scale, transpose, stab } = this.params;
    if (step % stab.everySteps !== 0) return [];
    // 和音は everySteps ごとに打ち込みつつ、同じ和音を repeatFor 回続けたあとで次へ進む
    // (進む間隔は everySteps * repeatFor)。移調はそれ自身の間隔で独立に進むので、同じ和音の
    // 繰り返し中でも移調が切り替われば響きは変わる。周期が食い違うぶんだけ、どちらも
    // 一巡するまで同じ組み合わせが戻ってこない。
    const shift = phaseValue(transpose, step);
    const chord = cycleAt(stab.chords, stab.everySteps * stab.repeatFor, step);
    return chord.map((index) => ({
      instrument: stab.instrument,
      freq: scaleFreq(scale, index, shift, stab.octaveOffset),
      offsetSec: 0,
      durationSec: stab.durationSec,
      velocity: 1,
    }));
  }
}
