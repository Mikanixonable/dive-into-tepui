// BGM の曲データ。1エントリ = 1曲で、どの Composer で鳴らすか(kind)と、その Composer が
// 食うパラメータを持つ。型と、パラメータの各フィールドの意味は types.ts。
import { BgmTrack } from './types';

export const BGM_TRACKS: BgmTrack[] = [
  {
    // D中心の旋法。16対12のポリリズムをゆっくり回す。
    kind: 'phasing',
    name: 'The Original',
    instruments: [
      { kind: 'tone', id: 'voiceA', params: { wave: 'sine', level: 0.03, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceA-harmonic', params: { wave: 'triangle', level: 0.009, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceB', params: { wave: 'triangle', level: 0.022, attackSec: 0.02, pan: 0 } },
      { kind: 'tone', id: 'pads', params: { wave: 'triangle', level: 0.013, attackSec: 4.5, pan: 0 } },
      { kind: 'tone', id: 'drone', params: { wave: 'sine', level: 0.02, attackSec: 6, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: {
      stepDur: 0.42,
      scale: [146.83, 164.81, 196, 220, 261.63, 293.66, 329.63, 392], // D3, E3, G3, A3, C4, D4, E4, G4
      transpose: { values: [0, 2, 3, 1], everySteps: 192 },
      octave: { values: [0, 1], everySteps: 768 },
      voiceA: {
        pattern: [0, 4, 2, 5, 3, 7, 2, 6, 0, 5, 3, 6, 2, 7, 4, 6],
        instrument: 'voiceA',
        lengthRatio: 1.3,
        stepOffset: 0,
        harmonic: { ratio: 2.003, instrument: 'voiceA-harmonic', lengthRatio: 0.7 },
      },
      voiceB: {
        pattern: [7, 3, 5, 2, 6, 4, 5, 3, 6, 2, 4, 5],
        instrument: 'voiceB',
        lengthRatio: 1.1,
        stepOffset: 0.5,
        harmonic: null,
      },
      pads: {
        chords: [
          [73.42, 98, 130.81, 196],
          [82.41, 110, 146.83, 220],
          [98, 130.81, 174.61, 261.63],
          [110, 146.83, 196, 293.66],
        ],
        everySteps: 32,
        instrument: 'pads',
        lengthRatio: 34,
      },
      drone: {
        voices: [{ pitch: 36.71, velocity: 1 }, { pitch: 73.42, velocity: 0.6 }], // D1, D2
        everySteps: 64,
        instrument: 'drone',
        lengthRatio: 66,
      },
      sparkle: {
        everySteps: 8,
        atStep: 5,
        indexStride: 5,
        octaveOffset: 2,
        durationSec: 0.5,
        instrument: 'sparkle',
        echoes: [{ delaySec: 0.63, velocity: 0.4545454545454546 }, { delaySec: 1.26, velocity: 0.2272727272727273 }],
      },
    },
  },
  {
    // Fリディア風。15対11で、より遅く、より希薄に。
    kind: 'phasing',
    name: 'Ethereal',
    instruments: [
      { kind: 'tone', id: 'voiceA', params: { wave: 'triangle', level: 0.03, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceA-harmonic', params: { wave: 'sine', level: 0.009, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceB', params: { wave: 'sine', level: 0.022, attackSec: 0.02, pan: 0 } },
      { kind: 'tone', id: 'pads', params: { wave: 'triangle', level: 0.013, attackSec: 4.5, pan: 0 } },
      { kind: 'tone', id: 'drone', params: { wave: 'sine', level: 0.02, attackSec: 6, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: {
      stepDur: 0.5,
      scale: [174.61, 196, 220, 246.94, 261.63, 329.63, 349.23, 392], // F3, G3, A3, B3, C4, E4, F4, G4
      transpose: { values: [0, 2, 3, 1], everySteps: 192 },
      octave: { values: [0, 1], everySteps: 768 },
      voiceA: {
        pattern: [0, 2, 4, 5, 7, 4, 2, 3, 1, 0, 3, 6, 5, 2, 1],
        instrument: 'voiceA',
        lengthRatio: 1.3,
        stepOffset: 0,
        harmonic: { ratio: 2.003, instrument: 'voiceA-harmonic', lengthRatio: 0.7 },
      },
      voiceB: {
        pattern: [7, 5, 2, 1, 3, 6, 4, 2, 0, 3, 5],
        instrument: 'voiceB',
        lengthRatio: 1.1,
        stepOffset: 0.5,
        harmonic: null,
      },
      pads: {
        chords: [
          [87.31, 130.81, 174.61, 261.63], // F2, C3, F3, C4
          [98, 146.83, 196, 293.66], // G2, D3, G3, D4
          [110, 164.81, 220, 329.63], // A2, E3, A3, E4
          [87.31, 146.83, 174.61, 293.66],
        ],
        everySteps: 32,
        instrument: 'pads',
        lengthRatio: 34,
      },
      drone: {
        voices: [{ pitch: 43.65, velocity: 1 }, { pitch: 87.31, velocity: 0.6 }], // F1, F2
        everySteps: 64,
        instrument: 'drone',
        lengthRatio: 66,
      },
      sparkle: {
        everySteps: 8,
        atStep: 5,
        indexStride: 5,
        octaveOffset: 2,
        durationSec: 0.5,
        instrument: 'sparkle',
        echoes: [{ delaySec: 0.63, velocity: 0.4545454545454546 }, { delaySec: 1.26, velocity: 0.2272727272727273 }],
      },
    },
  },
  {
    // Cマイナーペンタトニック。14対9、刻みは速く、音色は暗い。
    kind: 'phasing',
    name: 'Deep Space / Dark',
    instruments: [
      { kind: 'tone', id: 'voiceA', params: { wave: 'square', level: 0.03, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceA-harmonic', params: { wave: 'triangle', level: 0.009, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceB', params: { wave: 'sine', level: 0.022, attackSec: 0.02, pan: 0 } },
      { kind: 'tone', id: 'pads', params: { wave: 'triangle', level: 0.013, attackSec: 4.5, pan: 0 } },
      { kind: 'tone', id: 'drone', params: { wave: 'sine', level: 0.02, attackSec: 6, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: {
      stepDur: 0.35,
      scale: [130.81, 155.56, 174.61, 196, 233.08, 261.63, 311.13, 349.23], // C3, Eb3, F3, G3, Bb3, C4, Eb4, F4
      transpose: { values: [0, 2, 3, 1], everySteps: 192 },
      octave: { values: [0, 1], everySteps: 768 },
      voiceA: {
        pattern: [0, 3, 2, 1, 4, 7, 6, 5, 3, 2, 0, 1, 4, 6],
        instrument: 'voiceA',
        lengthRatio: 1.3,
        stepOffset: 0,
        harmonic: { ratio: 2.003, instrument: 'voiceA-harmonic', lengthRatio: 0.7 },
      },
      voiceB: {
        pattern: [7, 4, 2, 0, 5, 3, 1, 6, 4],
        instrument: 'voiceB',
        lengthRatio: 1.1,
        stepOffset: 0.5,
        harmonic: null,
      },
      pads: {
        chords: [
          [65.41, 98, 130.81, 196],
          [77.78, 116.54, 155.56, 233.08],
          [87.31, 130.81, 174.61, 261.63],
          [65.41, 116.54, 130.81, 233.08],
        ],
        everySteps: 32,
        instrument: 'pads',
        lengthRatio: 34,
      },
      drone: {
        voices: [{ pitch: 32.7, velocity: 1 }, { pitch: 65.41, velocity: 0.6 }], // C1, C2
        everySteps: 64,
        instrument: 'drone',
        lengthRatio: 66,
      },
      sparkle: {
        everySteps: 8,
        atStep: 5,
        indexStride: 5,
        octaveOffset: 2,
        durationSec: 0.5,
        instrument: 'sparkle',
        echoes: [{ delaySec: 0.63, velocity: 0.4545454545454546 }, { delaySec: 1.26, velocity: 0.2272727272727273 }],
      },
    },
  },
  {
    // Eメジャーペンタトニック。7対5の短い周期で、速く明るい。
    kind: 'phasing',
    name: 'Sparkling Crystal',
    instruments: [
      { kind: 'tone', id: 'voiceA', params: { wave: 'sine', level: 0.03, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceA-harmonic', params: { wave: 'sine', level: 0.009, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceB', params: { wave: 'triangle', level: 0.022, attackSec: 0.02, pan: 0 } },
      { kind: 'tone', id: 'pads', params: { wave: 'triangle', level: 0.013, attackSec: 4.5, pan: 0 } },
      { kind: 'tone', id: 'drone', params: { wave: 'sine', level: 0.02, attackSec: 6, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: {
      stepDur: 0.28,
      scale: [164.81, 185, 207.65, 246.94, 277.18, 329.63, 369.99, 415.3], // E3, F#3, G#3, B3, C#4, E4, F#4, G#4
      transpose: { values: [0, 2, 3, 1], everySteps: 192 },
      octave: { values: [0, 1], everySteps: 768 },
      voiceA: {
        pattern: [0, 2, 4, 3, 6, 5, 7],
        instrument: 'voiceA',
        lengthRatio: 1.3,
        stepOffset: 0,
        harmonic: { ratio: 2.003, instrument: 'voiceA-harmonic', lengthRatio: 0.7 },
      },
      voiceB: {
        pattern: [7, 4, 2, 5, 1],
        instrument: 'voiceB',
        lengthRatio: 1.1,
        stepOffset: 0.5,
        harmonic: null,
      },
      pads: {
        chords: [
          [82.41, 123.47, 164.81, 246.94],
          [92.5, 138.59, 185, 277.18],
          [103.83, 155.56, 207.65, 311.13],
          [82.41, 138.59, 164.81, 277.18],
        ],
        everySteps: 32,
        instrument: 'pads',
        lengthRatio: 34,
      },
      drone: {
        voices: [{ pitch: 41.2, velocity: 1 }, { pitch: 82.41, velocity: 0.6 }], // E1, E2
        everySteps: 64,
        instrument: 'drone',
        lengthRatio: 66,
      },
      sparkle: {
        everySteps: 8,
        atStep: 5,
        indexStride: 5,
        octaveOffset: 2,
        durationSec: 0.5,
        instrument: 'sparkle',
        echoes: [{ delaySec: 0.63, velocity: 0.4545454545454546 }, { delaySec: 1.26, velocity: 0.2272727272727273 }],
      },
    },
  },
  {
    // Aドリア。13対8、刻みは最も遅く、宙吊りの感触。
    kind: 'phasing',
    name: 'Suspended',
    instruments: [
      { kind: 'tone', id: 'voiceA', params: { wave: 'triangle', level: 0.03, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceA-harmonic', params: { wave: 'square', level: 0.009, attackSec: 0.015, pan: 0 } },
      { kind: 'tone', id: 'voiceB', params: { wave: 'triangle', level: 0.022, attackSec: 0.02, pan: 0 } },
      { kind: 'tone', id: 'pads', params: { wave: 'triangle', level: 0.013, attackSec: 4.5, pan: 0 } },
      { kind: 'tone', id: 'drone', params: { wave: 'sine', level: 0.02, attackSec: 6, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: {
      stepDur: 0.6,
      scale: [110, 123.47, 130.81, 146.83, 164.81, 185, 196, 220], // A2, B2, C3, D3, E3, F#3, G3, A3
      transpose: { values: [0, 2, 3, 1], everySteps: 192 },
      octave: { values: [0, 1], everySteps: 768 },
      voiceA: {
        pattern: [0, 4, 2, 7, 5, 3, 6, 1, 0, 3, 5, 2, 4],
        instrument: 'voiceA',
        lengthRatio: 1.3,
        stepOffset: 0,
        harmonic: { ratio: 2.003, instrument: 'voiceA-harmonic', lengthRatio: 0.7 },
      },
      voiceB: {
        pattern: [7, 4, 1, 6, 3, 0, 5, 2],
        instrument: 'voiceB',
        lengthRatio: 1.1,
        stepOffset: 0.5,
        harmonic: null,
      },
      pads: {
        chords: [
          [55, 82.41, 110, 164.81],
          [61.74, 92.5, 123.47, 185],
          [65.41, 98, 130.81, 196],
          [73.42, 110, 146.83, 220],
        ],
        everySteps: 32,
        instrument: 'pads',
        lengthRatio: 34,
      },
      drone: {
        voices: [{ pitch: 27.5, velocity: 1 }, { pitch: 55, velocity: 0.6 }], // A0, A1
        everySteps: 64,
        instrument: 'drone',
        lengthRatio: 66,
      },
      sparkle: {
        everySteps: 8,
        atStep: 5,
        indexStride: 5,
        octaveOffset: 2,
        durationSec: 0.5,
        instrument: 'sparkle',
        echoes: [{ delaySec: 0.63, velocity: 0.4545454545454546 }, { delaySec: 1.26, velocity: 0.2272727272727273 }],
      },
    },
  },
  {
    // The Original のアレンジ。ステレオ機能のテストも兼ねる。
    kind: 'phasing',
    name: 'Imitation',
    instruments: [
      { kind: 'tone', id: 'voiceA', params: { wave: 'sine', level: 0.05, attackSec: 0.015, pan: -0.5 } },
      { kind: 'tone', id: 'voiceA-harmonic', params: { wave: 'triangle', level: 0.02, attackSec: 0.015, pan: -0.5 } },
      { kind: 'tone', id: 'voiceB', params: { wave: 'triangle', level: 0.05, attackSec: 0.02, pan: 0.5 } },
      { kind: 'tone', id: 'pads', params: { wave: 'triangle', level: 0.02, attackSec: 4.5, pan: -0.2 } },
      { kind: 'tone', id: 'drone', params: { wave: 'sine', level: 0.04, attackSec: 6, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'square', level: 0.02, attackSec: 0.01, pan: 0.2 } },
    ],
    params: {
      stepDur: 0.3,
      scale: [146.83, 164.81, 174.61, 220, 261.63, 293.66, 329.63, 345.22], // D3, E3, F3, A3, C4, D4, E4, F4
      transpose: { values: [0, -1, 4, 2], everySteps: 192 },
      octave: { values: [0, 1], everySteps: 768 },
      voiceA: {
        pattern: [4, 2, 5, 3, 7, 2, 6, 0, 5, 3, 6, 2, 7, 4, 6, 0],
        instrument: 'voiceA',
        lengthRatio: 1.3,
        stepOffset: 0,
        harmonic: { ratio: 2.003, instrument: 'voiceA-harmonic', lengthRatio: 0.7 },
      },
      voiceB: {
        pattern: [7, 3, 5, 2, 6, 4, 5, 3, 6, 2, 4, 5],
        instrument: 'voiceB',
        lengthRatio: 1.1,
        stepOffset: 0.5,
        harmonic: null,
      },
      pads: {
        chords: [
          [73.42, 98, 130.81, 196],
          [82.41, 110, 146.83, 220],
          [98, 130.81, 174.61, 261.63],
          [110, 146.83, 196, 293.66],
        ],
        everySteps: 32,
        instrument: 'pads',
        lengthRatio: 34,
      },
      drone: {
        voices: [{ pitch: 36.71, velocity: 1 }, { pitch: 73.42, velocity: 0.6 }], // D1, D2
        everySteps: 64,
        instrument: 'drone',
        lengthRatio: 66,
      },
      sparkle: {
        everySteps: 10,
        atStep: 5,
        indexStride: 6,
        octaveOffset: 2,
        durationSec: 0.5,
        instrument: 'sparkle',
        echoes: [{ delaySec: 0.6, velocity: 0.4 }, { delaySec: 1.2, velocity: 0.2 }, { delaySec: 1.8, velocity: 0.1 }],
      },
    },
  },
  {
    kind: 'antipode',
    name: 'Madrid-Weber (sketch)',
    instruments: [
      { kind: 'unison', id: 'stab', params: {
        wave: 'sawtooth', voices: 3, detuneCents: 8, level: 0.2, attackSec: 0.01,
        filterOptions: { type: 'lowpass', frequency: 600, Q: 0.8 }, pan: 0 } },
      { kind: 'tone', id: 'arp', params: {
        wave: 'sine', level: 0.25, attackSec: 0.1, pan: 0
      }}
    ],
    params: {
      stepDur: 0.05,
      scale: [146.83, 155.56, 174.61, 196, 233.08, 293.66, 311.13, 349.23], // D3, D#3, F3, G3, A#3, D4, D#4, F4
      transpose: {
        values: [-1, 1, 0],
        everySteps: 180
      },
      stab: {
        everySteps: 6,
        repeatFor: 6,
        chords: [[0, 1, 4], [2, 3, 5]],
        octaveOffset: 1,
        durationSec: 0.9,
        instrument: 'stab'
      },
      arp: {
        everySteps: 3,
        notes: [0, 2, 4, 3, 5, 7, 1],
        octaveOffset: 0,
        instrument: 'arp'
      }
    },
  },
];
