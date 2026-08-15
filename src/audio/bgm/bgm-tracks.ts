// BGM の作曲データ。1エントリ = 1曲で、音階・パターン・和音と、各レイヤーをどう鳴らすかを持つ。
// 実際の発音とスケジューリングは bgm.ts の責務で、この表が決めるのは「何を鳴らすか」だけ。

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

export interface BgmTrack {
  name: string;
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

export const BGM_TRACKS: BgmTrack[] = [
  {
    // D中心の旋法。16対12のポリリズムをゆっくり回す。
    name: 'The Original',
    stepDur: 0.42,
    scale: [146.83, 164.81, 196.0, 220.0, 261.63, 293.66, 329.63, 392.0], // D3, E3, G3, A3, C4, D4, E4, G4
    transpose: { values: [0, 2, 3, 1], everySteps: 192 },
    octave: { values: [0, 1], everySteps: 768 },
    voiceA: {
      pattern: [0, 4, 2, 5, 3, 7, 2, 6, 0, 5, 3, 6, 2, 7, 4, 6],
      wave: 'sine',
      level: 0.03,
      lengthRatio: 1.3,
      attack: 0.015,
      stepOffset: 0,
      harmonic: { ratio: 2.003, wave: 'triangle', level: 0.009, lengthRatio: 0.7 },
    },
    voiceB: {
      pattern: [7, 3, 5, 2, 6, 4, 5, 3, 6, 2, 4, 5],
      wave: 'triangle',
      level: 0.022,
      lengthRatio: 1.1,
      attack: 0.02,
      stepOffset: 0.5,
      harmonic: null,
    },
    pads: {
      chords: [
        [73.42, 98.0, 130.81, 196.0],
        [82.41, 110.0, 146.83, 220.0],
        [98.0, 130.81, 174.61, 261.63],
        [110.0, 146.83, 196.0, 293.66],
      ],
      everySteps: 32,
      wave: 'triangle',
      level: 0.013,
      lengthRatio: 34,
      attack: 4.5,
    },
    drone: {
      voices: [{ pitch: 36.71, level: 0.02 }, { pitch: 73.42, level: 0.012 }], // D1, D2
      everySteps: 64,
      wave: 'sine',
      lengthRatio: 66,
      attack: 6,
    },
    sparkle: {
      everySteps: 8,
      atStep: 5,
      indexStride: 5,
      octaveOffset: 2,
      durationSec: 0.5,
      wave: 'sine',
      level: 0.011,
      attack: 0.01,
      echoes: [{ delaySec: 0.63, level: 0.005 }, { delaySec: 1.26, level: 0.0025 }],
    },
  },
  {
    // Fリディア風。15対11で、より遅く、より希薄に。
    name: 'Ethereal',
    stepDur: 0.5,
    scale: [174.61, 196.0, 220.0, 246.94, 261.63, 329.63, 349.23, 392.0], // F3, G3, A3, B3, C4, E4, F4, G4
    transpose: { values: [0, 2, 3, 1], everySteps: 192 },
    octave: { values: [0, 1], everySteps: 768 },
    voiceA: {
      pattern: [0, 2, 4, 5, 7, 4, 2, 3, 1, 0, 3, 6, 5, 2, 1],
      wave: 'triangle',
      level: 0.03,
      lengthRatio: 1.3,
      attack: 0.015,
      stepOffset: 0,
      harmonic: { ratio: 2.003, wave: 'sine', level: 0.009, lengthRatio: 0.7 },
    },
    voiceB: {
      pattern: [7, 5, 2, 1, 3, 6, 4, 2, 0, 3, 5],
      wave: 'sine',
      level: 0.022,
      lengthRatio: 1.1,
      attack: 0.02,
      stepOffset: 0.5,
      harmonic: null,
    },
    pads: {
      chords: [
        [87.31, 130.81, 174.61, 261.63], // F2, C3, F3, C4
        [98.0, 146.83, 196.0, 293.66], // G2, D3, G3, D4
        [110.0, 164.81, 220.0, 329.63], // A2, E3, A3, E4
        [87.31, 146.83, 174.61, 293.66],
      ],
      everySteps: 32,
      wave: 'triangle',
      level: 0.013,
      lengthRatio: 34,
      attack: 4.5,
    },
    drone: {
      voices: [{ pitch: 43.65, level: 0.02 }, { pitch: 87.31, level: 0.012 }], // F1, F2
      everySteps: 64,
      wave: 'sine',
      lengthRatio: 66,
      attack: 6,
    },
    sparkle: {
      everySteps: 8,
      atStep: 5,
      indexStride: 5,
      octaveOffset: 2,
      durationSec: 0.5,
      wave: 'sine',
      level: 0.011,
      attack: 0.01,
      echoes: [{ delaySec: 0.63, level: 0.005 }, { delaySec: 1.26, level: 0.0025 }],
    },
  },
  {
    // Cマイナーペンタトニック。14対9、刻みは速く、音色は暗い。
    name: 'Deep Space / Dark',
    stepDur: 0.35,
    scale: [130.81, 155.56, 174.61, 196.0, 233.08, 261.63, 311.13, 349.23], // C3, Eb3, F3, G3, Bb3, C4, Eb4, F4
    transpose: { values: [0, 2, 3, 1], everySteps: 192 },
    octave: { values: [0, 1], everySteps: 768 },
    voiceA: {
      pattern: [0, 3, 2, 1, 4, 7, 6, 5, 3, 2, 0, 1, 4, 6],
      wave: 'square',
      level: 0.03,
      lengthRatio: 1.3,
      attack: 0.015,
      stepOffset: 0,
      harmonic: { ratio: 2.003, wave: 'triangle', level: 0.009, lengthRatio: 0.7 },
    },
    voiceB: {
      pattern: [7, 4, 2, 0, 5, 3, 1, 6, 4],
      wave: 'sine',
      level: 0.022,
      lengthRatio: 1.1,
      attack: 0.02,
      stepOffset: 0.5,
      harmonic: null,
    },
    pads: {
      chords: [
        [65.41, 98.0, 130.81, 196.0],
        [77.78, 116.54, 155.56, 233.08],
        [87.31, 130.81, 174.61, 261.63],
        [65.41, 116.54, 130.81, 233.08],
      ],
      everySteps: 32,
      wave: 'triangle',
      level: 0.013,
      lengthRatio: 34,
      attack: 4.5,
    },
    drone: {
      voices: [{ pitch: 32.7, level: 0.02 }, { pitch: 65.41, level: 0.012 }], // C1, C2
      everySteps: 64,
      wave: 'sine',
      lengthRatio: 66,
      attack: 6,
    },
    sparkle: {
      everySteps: 8,
      atStep: 5,
      indexStride: 5,
      octaveOffset: 2,
      durationSec: 0.5,
      wave: 'sine',
      level: 0.011,
      attack: 0.01,
      echoes: [{ delaySec: 0.63, level: 0.005 }, { delaySec: 1.26, level: 0.0025 }],
    },
  },
  {
    // Eメジャーペンタトニック。7対5の短い周期で、速く明るい。
    name: 'Sparkling Crystal',
    stepDur: 0.28,
    scale: [164.81, 185.0, 207.65, 246.94, 277.18, 329.63, 369.99, 415.3], // E3, F#3, G#3, B3, C#4, E4, F#4, G#4
    transpose: { values: [0, 2, 3, 1], everySteps: 192 },
    octave: { values: [0, 1], everySteps: 768 },
    voiceA: {
      pattern: [0, 2, 4, 3, 6, 5, 7],
      wave: 'sine',
      level: 0.03,
      lengthRatio: 1.3,
      attack: 0.015,
      stepOffset: 0,
      harmonic: { ratio: 2.003, wave: 'sine', level: 0.009, lengthRatio: 0.7 },
    },
    voiceB: {
      pattern: [7, 4, 2, 5, 1],
      wave: 'triangle',
      level: 0.022,
      lengthRatio: 1.1,
      attack: 0.02,
      stepOffset: 0.5,
      harmonic: null,
    },
    pads: {
      chords: [
        [82.41, 123.47, 164.81, 246.94],
        [92.5, 138.59, 185.0, 277.18],
        [103.83, 155.56, 207.65, 311.13],
        [82.41, 138.59, 164.81, 277.18],
      ],
      everySteps: 32,
      wave: 'triangle',
      level: 0.013,
      lengthRatio: 34,
      attack: 4.5,
    },
    drone: {
      voices: [{ pitch: 41.2, level: 0.02 }, { pitch: 82.41, level: 0.012 }], // E1, E2
      everySteps: 64,
      wave: 'sine',
      lengthRatio: 66,
      attack: 6,
    },
    sparkle: {
      everySteps: 8,
      atStep: 5,
      indexStride: 5,
      octaveOffset: 2,
      durationSec: 0.5,
      wave: 'sine',
      level: 0.011,
      attack: 0.01,
      echoes: [{ delaySec: 0.63, level: 0.005 }, { delaySec: 1.26, level: 0.0025 }],
    },
  },
  {
    // Aドリア。13対8、刻みは最も遅く、宙吊りの感触。
    name: 'Suspended',
    stepDur: 0.6,
    scale: [110.0, 123.47, 130.81, 146.83, 164.81, 185.0, 196.0, 220.0], // A2, B2, C3, D3, E3, F#3, G3, A3
    transpose: { values: [0, 2, 3, 1], everySteps: 192 },
    octave: { values: [0, 1], everySteps: 768 },
    voiceA: {
      pattern: [0, 4, 2, 7, 5, 3, 6, 1, 0, 3, 5, 2, 4],
      wave: 'triangle',
      level: 0.03,
      lengthRatio: 1.3,
      attack: 0.015,
      stepOffset: 0,
      harmonic: { ratio: 2.003, wave: 'square', level: 0.009, lengthRatio: 0.7 },
    },
    voiceB: {
      pattern: [7, 4, 1, 6, 3, 0, 5, 2],
      wave: 'triangle',
      level: 0.022,
      lengthRatio: 1.1,
      attack: 0.02,
      stepOffset: 0.5,
      harmonic: null,
    },
    pads: {
      chords: [
        [55.0, 82.41, 110.0, 164.81],
        [61.74, 92.5, 123.47, 185.0],
        [65.41, 98.0, 130.81, 196.0],
        [73.42, 110.0, 146.83, 220.0],
      ],
      everySteps: 32,
      wave: 'triangle',
      level: 0.013,
      lengthRatio: 34,
      attack: 4.5,
    },
    drone: {
      voices: [{ pitch: 27.5, level: 0.02 }, { pitch: 55.0, level: 0.012 }], // A0, A1
      everySteps: 64,
      wave: 'sine',
      lengthRatio: 66,
      attack: 6,
    },
    sparkle: {
      everySteps: 8,
      atStep: 5,
      indexStride: 5,
      octaveOffset: 2,
      durationSec: 0.5,
      wave: 'sine',
      level: 0.011,
      attack: 0.01,
      echoes: [{ delaySec: 0.63, level: 0.005 }, { delaySec: 1.26, level: 0.0025 }],
    },
  },
];
