// 楽器宣言の型。音符をどの楽器で鳴らすか(kind)と、その楽器が食うパラメータ(params)の
// 形をここで定める。楽器の実装は同じ階層の各ファイル、kind から実装を選ぶのは
// ../instrument-factory.ts。
// 楽器を増やすときは、下の区画へ params 型を書き、union へ1行加える。

// 1つの楽器の宣言。id は Composer が出す音符から参照される名前で、曲の中で一意。
export type InstrumentDef =
  | { kind: 'tone'; id: string; params: ToneParams }
  | { kind: 'unison'; id: string; params: UnisonParams };

// ================================================================= tone-instrument

// 発振器1つを包絡で鳴らすだけの楽器(tone-instrument.ts)のパラメータ。
export interface ToneParams {
  wave: OscillatorType;
  level: number; // velocity 1 のときの音量
  attackSec: number;
  pan: number; // -1(左)〜 1(右)
}

// ================================================================= unison-instrument

// 同じ音程をずらして重ねる楽器(unison-instrument.ts)のパラメータ。
export interface UnisonParams {
  wave: OscillatorType;
  voices: number; // unison voice 数
  detuneCents: number; // 各 voice のデチューン
  level: number; // velocity 1 のときの音量
  attackSec: number; // 振幅のアタック
  filterOptions: BiquadFilterOptions; // フィルターのオプション
  pan: number; // -1(左)〜 1(右)
}
