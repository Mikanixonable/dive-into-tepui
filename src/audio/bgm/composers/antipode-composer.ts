// 2つ目の作曲アルゴリズム。一定ステップごとに和音を短く打ち込む層(stab)に、音階を1つずつ
// なぞる音型の層(arps、複数可)を重ねる。stab・各 arp 層・移調はそれぞれ自分の間隔で独立に
// 進むので、周期が食い違うぶんだけ組み合わせが移り変わる — 同じ和音が違う高さで、同じ音型が
// 違う和音の上で鳴り、複数の arp 層どうしも互いの位置に関知せずずれていく。
// 音階・和音・音型・間隔は AntipodeParams が持つ。
import { AntipodeParams } from '../tracks/types';
import { Composer, ComposerNote } from '../composer';
import { cycleAt, phaseValue, scaleFreq } from './utils';

export class AntipodeComposer implements Composer {
  constructor(private readonly params: AntipodeParams) {}

  get stepDurSec(): number {
    return this.params.stepDur;
  }

  // stab と各 arp 層のうち、このステップが打ち込みの位置になっている層だけを移調して返す。
  notesAt(step: number): ComposerNote[] {
    const { transpose } = this.params;
    const shift = phaseValue(transpose, step);
    const notes: ComposerNote[] = [];
    notes.push(...this.stabNotes(step, shift));
    notes.push(...this.arpNotes(step, shift));
    return notes;
  }

  // このステップが打ち込みの位置なら、そのとき選ばれている和音を返す。
  private stabNotes(step: number, shift: number): ComposerNote[] {
    const { scale, stab } = this.params;
    if (step % stab.everySteps !== 0) return [];
    // 和音は everySteps ごとに打ち込みつつ、同じ和音を repeatFor 回続けたあとで次へ進む
    // (進む間隔は everySteps * repeatFor)。移調はそれ自身の間隔で独立に進むので、同じ和音の
    // 繰り返し中でも移調が切り替われば響きは変わる。
    const chord = cycleAt(stab.chords, stab.everySteps * stab.repeatFor, step);
    return chord.map((index) => ({
      instrument: stab.instrument,
      freq: scaleFreq(scale, index, shift, stab.octaveOffset),
      offsetSec: 0,
      durationSec: stab.durationSec,
      velocity: 1,
    }));
  }

  // 各 arp 層のうち、このステップが打ち込みの位置になっているものだけ、notes を1つずつ
  // なぞる音型の現在位置を返す。層どうしは互いの間隔に関知しない。
  private arpNotes(step: number, shift: number): ComposerNote[] {
    const { scale, stepDur, arps } = this.params;
    // 音の長さは arp 側に指定が無いので、次の音が来るまでの間隔(stepDur * everySteps)を
    // そのまま使う — 途切れず受け渡される歌い方になる。
    return arps.flatMap((arp): ComposerNote[] => {
      if (step % arp.everySteps !== 0) return [];
      const index = cycleAt(arp.notes, arp.everySteps, step);
      return [{
        instrument: arp.instrument,
        freq: scaleFreq(scale, index, shift, arp.octaveOffset),
        offsetSec: 0,
        durationSec: stepDur * arp.everySteps,
        velocity: 1,
      }];
    });
  }
}
