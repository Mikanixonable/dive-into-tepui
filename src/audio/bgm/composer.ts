// BGM の楽曲生成アルゴリズムの共通インターフェース。ステップ番号から「何をどう鳴らすか」を
// 決めるところまでを受け持ち、いつ鳴らすか(再生・停止・曲の切替)と、音を実際に WebAudio へ
// 流すことは持たない。WebAudio に依存しないので、生成される音列だけを取り出して検証できる。

// 1音ぶんの指示。発音位置だけがステップ開始からの相対時刻で、残りは秒とレベルの絶対値。
export interface ComposerNote {
  freq: number;
  offsetSec: number; // ステップ開始からの相対時刻
  durationSec: number;
  level: number;
  wave: OscillatorType;
  attackSec: number;
}

export interface Composer {
  // 1ステップの秒数。再生側はこの間隔でステップを進める。
  readonly stepDurSec: number;
  // step 番目のステップで鳴らす音を返す。同じ step には常に同じ音列を返す。
  notesAt(step: number): readonly ComposerNote[];
}
