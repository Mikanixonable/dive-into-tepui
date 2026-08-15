// 2つ目の作曲アルゴリズムの下書き。まだ音を返さないので、これで鳴らすトラックを
// BGM_TRACKS へ足すのは notesAt を書いてから。
// 音階インデックスから周波数を引く必要が出たら、phasing-composer.ts の scaleFreq が
// そのまま使える形になっているので、共有の場所へ出して両方から引く。
import { SketchParams } from './bgm-tracks';
import { Composer, ComposerNote } from './composer';

export class SketchComposer implements Composer {
  constructor(private readonly params: SketchParams) {}

  get stepDurSec(): number {
    return this.params.stepDur;
  }

  notesAt(_step: number): ComposerNote[] {
    return [];
  }
}
