// Composer どうしで共有する小さな道具。どれも状態を持たず、トラックのパラメータと
// ステップ番号だけから値を出す。音集合や循環の中身そのものは各トラックが持つ。
import { PhaseCycle } from '../tracks/types';

// 一定ステップごとに切り替わる循環から、このステップの値を取り出す。
export function phaseValue(cycle: PhaseCycle, step: number): number {
  return cycle.values[Math.floor(step / cycle.everySteps) % cycle.values.length]!;
}

// 一定ステップごとに1つ進む列から、このステップの要素を取り出す。
// everySteps は列の進み方とは独立でよく、周期が食い違うほど組み合わせが長く一巡する。
export function cycleAt<T>(items: T[], everySteps: number, step: number): T {
  return items[Math.floor(step / everySteps) % items.length]!;
}

// 音階インデックスへ移調とオクターブシフトを適用し、周波数へ解決する。
// 音階の端を越えたぶんはオクターブへ繰り上げ・繰り下げて折り返す。
export function scaleFreq(scale: number[], index: number, transpose: number, octave: number): number {
  let absoluteIdx = index + transpose;
  let octShift = octave;
  // 音階の上端を超えたらオクターブを上げて折り返す
  while (absoluteIdx >= scale.length) {
    absoluteIdx -= scale.length;
    octShift++;
  }
  // 下端を下回ったらオクターブを下げて折り返す
  while (absoluteIdx < 0) {
    absoluteIdx += scale.length;
    octShift--;
  }
  return scale[absoluteIdx]! * Math.pow(2, octShift);
}
