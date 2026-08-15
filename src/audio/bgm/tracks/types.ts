// トラック宣言の型。1曲がどの Composer で鳴るか(kind)と、その Composer が食う
// パラメータ(params)の形をここで定める。曲そのもののデータは tracks.ts。
// Composer を増やすときは、下へ区画をひとつ足して params 型を書き、union へ1行加える。

// -------------------------------------------------------------------------- 共通
// 1曲ぶんの宣言。kind がどの Composer で鳴らすかを決め、params の形はその kind ごとに違う。
// name だけは kind に依らず共通で、曲目一覧のように中身を問わない読み手がこれを引く。
export type BgmTrack =
  | { kind: 'phasing'; name: string; params: PhasingParams }
  | { kind: 'sketch'; name: string; params: SketchParams };

// ------------------------------------------------------------ phasing-composer
// 一定ステップごとに値を切り替える循環。everySteps ごとに values を1つ進み、末尾で先頭へ戻る。
// values の長さ × everySteps がこの循環の一巡で、曲全体の周期はこれらの最小公倍数になる。
export interface PhaseCycle {
  values: number[];
  everySteps: number;
}

// パルス声部へ重ねる倍音。整数比からわずかにずらすと、うなりが厚みになる。
export interface VoiceHarmonic {
  ratio: number;
  wave: OscillatorType;
  level: number;
  lengthRatio: number; // stepDur に対する音長
}

// 音階インデックスの列を1ステップ1音で鳴らす声部。長さの互いに素な列を複数重ねると、
// 位相が少しずつずれていくライヒ的なフェイジングになる。
export interface PulseVoice {
  pattern: number[]; // 音階インデックスの列。長さがこの声部の周期
  wave: OscillatorType;
  level: number;
  lengthRatio: number; // stepDur に対する音長
  attack: number; // 秒
  stepOffset: number; // 発音位置をずらす拍数(0.5 = 半拍後ろ)
  harmonic: VoiceHarmonic | null;
}

// 一定ステップごとに和音を差し替えて漂わせるパッド。和音は Hz で直接与える。
export interface PadLayer {
  chords: number[][];
  everySteps: number;
  wave: OscillatorType;
  level: number;
  lengthRatio: number;
  attack: number;
}

// 低音のうなり。声部ごとに音量を変えて厚みを作る。音高は Hz で直接与える。
export interface DroneLayer {
  voices: { pitch: number; level: number }[];
  everySteps: number;
  wave: OscillatorType;
  lengthRatio: number;
  attack: number;
}

// ときおり差し込む高音の煌めきと、その減衰エコー。
export interface SparkleLayer {
  everySteps: number;
  atStep: number; // everySteps 周期のどの位置で鳴らすか
  indexStride: number; // ステップ番号から音階インデックスを選ぶときの歩幅
  octaveOffset: number;
  durationSec: number;
  wave: OscillatorType;
  level: number;
  attack: number;
  echoes: { delaySec: number; level: number }[];
}

// 位相をずらす2声のパルスを核にした作曲アルゴリズム(composers/phasing-composer.ts)のパラメータ。
export interface PhasingParams {
  stepDur: number; // 1ステップの秒数
  scale: number[]; // Hz。パルス声部と煌めきが引く音集合
  transpose: PhaseCycle; // 音階ステップ単位の移調
  octave: PhaseCycle; // オクターブ単位の音域移動
  voiceA: PulseVoice;
  voiceB: PulseVoice;
  pads: PadLayer;
  drone: DroneLayer;
  sparkle: SparkleLayer | null;
}

// ------------------------------------------------------------- sketch-composer
// これから設計する2つ目のアルゴリズム(composers/sketch-composer.ts)のパラメータ。
// 必要なフィールドは音を書きながら足す。
export interface SketchParams {
  stepDur: number; // 1ステップの秒数
}
