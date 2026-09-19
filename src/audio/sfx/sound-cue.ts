// 一回きりの効果音の宣言1件。id は鳴らす側が振る通し番号で、装置は同じ id を二度鳴らさない。
export interface SoundCue<Sound> {
  readonly id: number;
  readonly sound: Sound;
}
