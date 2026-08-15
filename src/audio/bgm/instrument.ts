// 音を実際の響きにする楽器の共通インターフェース。Composer が「何をどう鳴らすか」を決め、
// Instrument が「それがどんな音か」を受け持つ。
//
// 実装の約束:
//  - play は ctx.currentTime を読んではいけない。スケジューラは先読みで動くので、
//    包絡も変調もすべて引数の when から導くこと。読むと先読みぶんだけ音がずれる。
//  - 音符ごとに作るノードは play の中で作って捨てる。曲の間ずっと要るもの(LFO・共有フィルタ・
//    定位など)はコンストラクタで組み、使い回す。
//  - 残響やディレイのような重い処理は楽器の中に置かない。音符ごとに1つずつ作ることになる。
export interface Instrument {
  // freq の音を、時刻 when から durationSec 秒ぶん、強さ velocity(0..1)で鳴らす。
  // 減衰の終わりまで含めた後始末も実装側の責務。
  play(freq: number, when: number, durationSec: number, velocity: number): void;
}
