// 2つ目の作曲アルゴリズム。いまは一定ステップごとに和音を短く打ち込む層だけを持つ。
// 音階・和音・間隔は AntipodeParams が持つ。
import { AntipodeParams } from '../tracks/types';
import { Composer, ComposerNote } from '../composer';
import { scaleFreq } from './scale';

export class AntipodeComposer implements Composer {
  constructor(private readonly params: AntipodeParams) {}

  get stepDurSec(): number {
    return this.params.stepDur;
  }

  // このステップが打ち込みの位置なら、和音の構成音をまとめて返す。それ以外は無音。
  notesAt(step: number): ComposerNote[] {
    const { scale, stab } = this.params;
    if (step % stab.everySteps !== 0) return [];
    return stab.notes.map((index) => ({
      instrument: stab.instrument,
      freq: scaleFreq(scale, index, 0, stab.octaveOffset),
      offsetSec: 0,
      durationSec: stab.durationSec,
      velocity: 1,
    }));
  }
}
