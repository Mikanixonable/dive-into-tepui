// トラック宣言の型。1曲がどの Composer で鳴るか(kind)と、その Composer が食うパラメータ
// (params)の形をここで定める。曲そのもののデータは tracks.ts、
// 音符を実際の響きにする楽器の宣言は ../instruments/types.ts。
// Composer を増やすときは、対応する区画へ params 型を書き、union へ1行加える。
import { InstrumentDef } from '../instruments/types';

// ============================================================================ 共通

// 1曲ぶんの宣言。kind がどの Composer で鳴らすかを決め、params の形はその kind ごとに違う。
// name と instruments は kind に依らず共通 — 曲目一覧は中身を問わず name を引き、
// どの Composer も音符を出す以上それを鳴らす楽器が要るため。
export type BgmTrack =
  | { kind: 'phasing'; name: string; instruments: InstrumentDef[]; params: PhasingParams }
  | { kind: 'antipode'; name: string; instruments: InstrumentDef[]; params: AntipodeParams }
  | { kind: 'suite'; name: string; instruments: InstrumentDef[]; params: SuiteParams };

// ================================================================== Composer params

// 一定ステップごとに値を切り替える循環。everySteps ごとに values を1つ進み、末尾で先頭へ戻る。
// values の長さ × everySteps がこの循環の一巡で、曲全体の周期はこれらの最小公倍数になる。
export interface PhaseCycle {
  values: number[];
  everySteps: number;
}

// --------------------------------------------------------------- phasing-composer

// パルス声部へ重ねる倍音。整数比からわずかにずらすと、うなりが厚みになる。
interface VoiceHarmonic {
  ratio: number;
  instrument: string;
  lengthRatio: number; // stepDur に対する音長
}

// 音階インデックスの列を1ステップ1音で鳴らす声部。長さの互いに素な列を複数重ねると、
// 位相が少しずつずれていくライヒ的なフェイジングになる。
export interface PulseVoice {
  pattern: number[]; // 音階インデックスの列。長さがこの声部の周期
  instrument: string;
  lengthRatio: number; // stepDur に対する音長
  stepOffset: number; // 発音位置をずらす拍数(0.5 = 半拍後ろ)
  harmonic: VoiceHarmonic | null;
}

// 一定ステップごとに和音を差し替えて漂わせるパッド。和音は Hz で直接与える。
export interface PadLayer {
  chords: number[][];
  everySteps: number;
  instrument: string;
  lengthRatio: number;
}

// 低音のうなり。声部ごとに強さを変えて厚みを作る。音高は Hz で直接与える。
export interface DroneLayer {
  voices: { pitch: number; velocity: number }[];
  everySteps: number;
  instrument: string;
  lengthRatio: number;
}

// ときおり差し込む高音の煌めきと、その減衰エコー。
export interface SparkleLayer {
  everySteps: number;
  atStep: number; // everySteps 周期のどの位置で鳴らすか
  indexStride: number; // ステップ番号から音階インデックスを選ぶときの歩幅
  octaveOffset: number;
  durationSec: number;
  instrument: string;
  echoes: { delaySec: number; velocity: number }[];
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

// ----------------------------------------------------------------- suite-composer

// PhasingParams による1区間。lengthSteps ぶん進んだら次の区間へ移り、全区間を終えたら
// 最初の区間の先頭(local step 0)へ戻る。
export interface SuiteSection {
  params: PhasingParams;
  lengthSteps: number;
}

// 複数の phasing 区間を順につないで1曲にする composer(composers/suite-composer.ts)の
// パラメータ。緩急・音域・音色が区間ごとに変わる、複数部構成の曲に使う。
export interface SuiteParams {
  sections: SuiteSection[];
}

// -------------------------------------------------------------- antipode-composer

// 一定ステップごとに和音を短く打ち込む層。構成音は scale のインデックスで与える。
interface AntipodeStabLayer {
  everySteps: number;
  repeatFor: number; // 同じ和音を何回続けて鳴らすか
  chords: number[][]; // 和音の構成音インデックス
  octaveOffset: number;
  durationSec: number;
  instrument: string;
}

// 一定ステップごとに notes を1つずつなぞる音型の層。stab と違い、そのステップでは
// 1音だけを鳴らす。長さは指定せず、次の音が来るまでの間隔(stepDur * everySteps)を使う。
interface AntipodeArpLayer {
  everySteps: number;
  notes: number[]; // 音型の構成音インデックス。1周期でここを先頭から順になぞる
  octaveOffset: number;
  instrument: string;
}

// 2つ目の作曲アルゴリズム(composers/antipode-composer.ts)のパラメータ。
export interface AntipodeParams {
  stepDur: number; // 1ステップの秒数
  scale: number[]; // Hz。層が音階インデックスで引く音集合
  transpose: PhaseCycle; // 音階ステップ単位の移調
  stab: AntipodeStabLayer;
  arps: AntipodeArpLayer[]; // 各層が自分の everySteps で独立に進む。0個でも鳴らせる
}
