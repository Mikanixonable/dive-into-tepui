// 音階を引く Composer が共有する解決。音集合そのもの(Hz の並び)は各トラックが持ち、
// ここにあるのはインデックスから周波数を取り出す規則だけ。

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
