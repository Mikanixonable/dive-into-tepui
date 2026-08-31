// 複数の PhasingComposer を順番に切り替える Composer。三部構成の曲のように、緩急・音域・
// 音色の異なる区間を経ながら1曲を通す。各区間の内部ステップは区間に入るたび0から始まる
// (同じ step には常に同じ音列を返す)。全区間の合計ステップが一巡で、末尾まで来たら先頭へ戻る。
import { SuiteParams } from '../tracks/types';
import { Composer, ComposerNote } from '../composer';
import { PhasingComposer } from './phasing-composer';

export class SuiteComposer implements Composer {
  private readonly composers: PhasingComposer[];
  private readonly lengths: number[];
  private readonly totalSteps: number;
  // notesAt() が選んだ区間の stepDur を控え、直後に読まれる stepDurSec へ渡す。呼び出し側は
  // 毎ステップ notesAt() → stepDurSec の順に読むので、この順序に依存してよい。
  private currentStepDur: number;

  constructor(params: SuiteParams) {
    this.composers = params.sections.map((section) => new PhasingComposer(section.params));
    this.lengths = params.sections.map((section) => section.lengthSteps);
    this.totalSteps = this.lengths.reduce((sum, n) => sum + n, 0);
    this.currentStepDur = this.composers[0]!.stepDurSec;
  }

  get stepDurSec(): number {
    return this.currentStepDur;
  }

  notesAt(step: number): readonly ComposerNote[] {
    let local = step % this.totalSteps;
    for (let i = 0; i < this.lengths.length; i++) {
      if (local < this.lengths[i]!) {
        const composer = this.composers[i]!;
        this.currentStepDur = composer.stepDurSec;
        return composer.notesAt(local);
      }
      local -= this.lengths[i]!;
    }
    throw new Error('unreachable: local step exceeded total suite length');
  }
}
