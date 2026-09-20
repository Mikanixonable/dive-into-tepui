// BGM 楽曲生成アルゴリズムの共通インターフェース。ステップ番号に応じた音列生成を担当する。
// WebAudio から独立した純粋な生成モデルであり、生成結果を直接検証できる。

// 1音ぶんの指示。どんな響きになるかは楽器の側が決めるので、ここには音そのものの作り方を書かない。
export interface ComposerNote {
  instrument: string; // この音を鳴らす楽器の id。トラックの instruments が持つ名前
  freq: number;
  offsetSec: number; // ステップ開始からの相対時刻
  durationSec: number;
  velocity: number; // 0..1。どれくらい強く鳴らすか。音量や音色への効き方は楽器が決める
}

export interface Composer {
  // 1ステップの秒数。再生側はこの間隔でステップを進める。
  readonly stepDurSec: number;
  // step 番目のステップで鳴らす音を返す。同じ step には常に同じ音列を返す。
  notesAt(step: number): readonly ComposerNote[];
}
