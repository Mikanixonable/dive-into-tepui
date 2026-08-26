// BGM の曲データ。1エントリ = 1曲で、どの Composer で鳴らすか(kind)と、その Composer が
// 食うパラメータを持つ。型と、パラメータの各フィールドの意味は types.ts。
import { BgmTrack } from './types';
import { section } from './suite-builder';

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
    name: 'Madrid-Weber v1',
    instruments: [
      { kind: 'unison', id: 'stab', params: {
        wave: 'sawtooth', voices: 3, detuneCents: 8, level: 0.08, attackSec: 0.01,
        filterOptions: { type: 'lowpass', frequency: 500, Q: 0.8 }, pan: 0 } },
      { kind: 'tone', id: 'arp1', params: {
        wave: 'sine', level: 0.1, attackSec: 0.1, pan: -0.7
      }},
      { kind: 'tone', id: 'arp2', params: {
        wave: 'sine', level: 0.08, attackSec: 0.05, pan: 0.7
      }},
      { kind: 'unison', id: 'arp3', params: {
        wave: 'triangle', voices: 5, detuneCents: 12, level: 0.1, attackSec: 0.02,
        filterOptions: { type: 'bandpass', frequency: 1600, Q: 1 }, pan: 0 } },
    ],
    params: {
      stepDur: 0.1,
      scale: [146.83, 155.56, 174.61, 196, 233.08, 293.66, 311.13, 349.23], // D3, D#3, F3, G3, A#3, D4, D#4, F4
      transpose: {
        values: [-1, 1, 0],
        everySteps: 180
      },
      stab: {
        everySteps: 3,
        repeatFor: 6,
        chords: [[0, 1, 4], [2, 3, 5]],
        octaveOffset: 0,
        durationSec: 0.9,
        instrument: 'stab'
      },
      arps: [
        {
          everySteps: 2,
          notes: [0, 2, 4, 3, 5, 7, 1],
          octaveOffset: 1,
          instrument: 'arp1'
        },
        {
          everySteps: 2,
          notes: [3, 5, 7, 1, 0, 2, 4, 6],
          octaveOffset: 1,
          instrument: 'arp2'
        },
        {
          everySteps: 9,
          notes: [6, 1, 2, 4],
          octaveOffset: 2,
          instrument: 'arp3'
        }
      ]
    },
  },
  {
    // 5分・三部構成(各部さらに3区間)。緩急(部)・音域(区間の octave)・軽重(区間ごとに
    // 差し替える楽器)の3軸を組み合わせて、部を跨ぐたびに違う掛け合わせが出るようにする。
    // 第一部はゆっくり・第二部は軽快で速い・第三部は第一部の変奏(パターンと和音を厚くする)。
    // Gミクソリディア。
    kind: 'suite',
    name: 'Driftwheel',
    instruments: [
      { kind: 'tone', id: 'voiceA-heavy', params: { wave: 'triangle', level: 0.032, attackSec: 0.05, pan: 0 } },
      { kind: 'tone', id: 'voiceA-heavy-harmonic', params: { wave: 'sine', level: 0.01, attackSec: 0.05, pan: 0 } },
      { kind: 'tone', id: 'voiceA-light', params: { wave: 'sine', level: 0.028, attackSec: 0.012, pan: 0 } },
      { kind: 'tone', id: 'voiceA-light-harmonic', params: { wave: 'triangle', level: 0.008, attackSec: 0.012, pan: 0 } },
      { kind: 'tone', id: 'voiceB-heavy', params: { wave: 'sine', level: 0.024, attackSec: 0.06, pan: 0 } },
      { kind: 'tone', id: 'voiceB-light', params: { wave: 'triangle', level: 0.02, attackSec: 0.018, pan: 0 } },
      { kind: 'tone', id: 'pads-heavy', params: { wave: 'triangle', level: 0.015, attackSec: 5.5, pan: 0 } },
      { kind: 'tone', id: 'pads-light', params: { wave: 'triangle', level: 0.011, attackSec: 2.4, pan: 0 } },
      { kind: 'tone', id: 'drone-heavy', params: { wave: 'sine', level: 0.022, attackSec: 7, pan: 0 } },
      { kind: 'tone', id: 'drone-light', params: { wave: 'sine', level: 0.015, attackSec: 4, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: { sections: (() => {
      const scale = [196, 220, 246.94, 261.63, 293.66, 329.63, 349.23, 392]; // G3, A3, B3, C4, D4, E4, F4, G4
      const padsBase = [
        [98, 130.81, 174.61, 261.63],
        [110, 146.83, 196, 293.66],
        [123.47, 164.81, 220, 329.63],
        [130.81, 174.61, 246.94, 349.23],
      ];
      const padsRich = [
        [98, 130.81, 174.61, 261.63, 392],
        [110, 146.83, 196, 293.66, 440],
        [123.47, 164.81, 220, 329.63, 493.88],
        [130.81, 174.61, 246.94, 349.23, 523.25],
      ];
      const droneBase = [{ pitch: 49, velocity: 1 }, { pitch: 98, velocity: 0.6 }]; // G1, G2
      const droneRich = [{ pitch: 49, velocity: 1 }, { pitch: 98, velocity: 0.6 }, { pitch: 73.42, velocity: 0.4 }]; // + D2
      const sparkleLight = {
        everySteps: 8, atStep: 5, indexStride: 5, octaveOffset: 2, durationSec: 0.4, instrument: 'sparkle',
        echoes: [{ delaySec: 0.5, velocity: 0.4 }, { delaySec: 1.0, velocity: 0.2 }],
      };
      return [
        // 第一部(ゆっくり)
        section({
          lengthSteps: 63, stepDur: 0.52, scale, transposeValues: [0, 3, 1], transposeEverySteps: 48, octave: -1,
          voiceAPattern: [0, 4, 2, 6, 3, 7, 1, 5, 2, 6, 0, 3, 7], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [7, 3, 5, 1, 6, 2, 4, 0, 5, 2, 6], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsBase, everySteps: 32, lengthRatio: 34, instrument: 'pads-heavy' },
          drone: { voices: droneBase, everySteps: 64, lengthRatio: 66, instrument: 'drone-heavy' },
          sparkle: null,
        }),
        section({
          lengthSteps: 63, stepDur: 0.52, scale, transposeValues: [2, 0, 3], transposeEverySteps: 40, octave: 1,
          voiceAPattern: [0, 2, 4, 6, 1, 3, 5, 7, 2, 4, 6, 0, 3, 5, 7, 1, 4], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [7, 5, 3, 1, 6, 4, 2, 0, 5, 3, 1, 6, 4], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsBase, everySteps: 24, lengthRatio: 20, instrument: 'pads-light' },
          drone: { voices: droneBase, everySteps: 96, lengthRatio: 50, instrument: 'drone-light' },
          sparkle: sparkleLight,
        }),
        section({
          lengthSteps: 63, stepDur: 0.52, scale, transposeValues: [1, 3, 0, 2], transposeEverySteps: 44, octave: 0,
          voiceAPattern: [0, 3, 6, 1, 4, 7, 2, 5, 0, 4, 7, 2, 6, 1, 5, 0, 3, 7, 2], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [7, 4, 1, 6, 3, 0, 5, 2, 7, 4, 1, 6, 3, 0], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsBase, everySteps: 32, lengthRatio: 34, instrument: 'pads-heavy' },
          drone: { voices: droneBase, everySteps: 64, lengthRatio: 66, instrument: 'drone-heavy' },
          sparkle: null,
        }),
        // 第二部(軽快で速い)
        section({
          lengthSteps: 122, stepDur: 0.27, scale, transposeValues: [0, 2, 3, 1], transposeEverySteps: 20, octave: 1,
          voiceAPattern: [0, 2, 4, 6, 3, 5, 7, 1, 4, 6, 0, 2, 5, 7, 3], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [7, 4, 2, 0, 6, 3, 1, 5, 7, 4, 2], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsBase, everySteps: 16, lengthRatio: 14, instrument: 'pads-light' },
          drone: { voices: droneBase, everySteps: 48, lengthRatio: 30, instrument: 'drone-light' },
          sparkle: sparkleLight,
        }),
        section({
          lengthSteps: 122, stepDur: 0.27, scale, transposeValues: [3, 1, 0], transposeEverySteps: 24, octave: -1,
          voiceAPattern: [0, 5, 2, 7, 4, 1, 6, 3, 0, 5, 2, 7, 4], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [7, 2, 5, 0, 3, 6, 1, 4, 7, 2, 5, 0, 3, 6, 1, 4, 7], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsBase, everySteps: 24, lengthRatio: 20, instrument: 'pads-heavy' },
          drone: { voices: droneBase, everySteps: 48, lengthRatio: 40, instrument: 'drone-heavy' },
          sparkle: null,
        }),
        section({
          lengthSteps: 122, stepDur: 0.27, scale, transposeValues: [2, 0, 1, 3], transposeEverySteps: 18, octave: 0,
          voiceAPattern: [0, 4, 1, 5, 2, 6, 3, 7, 0, 4, 1, 5, 2, 6, 3, 7, 0], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [7, 3, 0, 4, 1, 5, 2, 6, 3, 0, 4, 1, 5], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsBase, everySteps: 16, lengthRatio: 14, instrument: 'pads-light' },
          drone: { voices: droneBase, everySteps: 64, lengthRatio: 30, instrument: 'drone-light' },
          sparkle: sparkleLight,
        }),
        // 第三部(第一部の変奏。パターンと和音を厚くする)
        section({
          lengthSteps: 63, stepDur: 0.52, scale, transposeValues: [0, 3, 1, 4], transposeEverySteps: 48, octave: -1,
          voiceAPattern: [4, 0, 6, 2, 7, 3, 1, 5, 6, 2, 4, 0, 7], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [3, 7, 5, 1, 2, 6, 4, 0, 3, 5, 7], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsRich, everySteps: 32, lengthRatio: 34, instrument: 'pads-heavy' },
          drone: { voices: droneRich, everySteps: 64, lengthRatio: 66, instrument: 'drone-heavy' },
          sparkle: {
            everySteps: 16, atStep: 9, indexStride: 7, octaveOffset: 2, durationSec: 0.5, instrument: 'sparkle',
            echoes: [{ delaySec: 0.6, velocity: 0.3 }],
          },
        }),
        section({
          lengthSteps: 63, stepDur: 0.52, scale, transposeValues: [2, 0, 4, 3], transposeEverySteps: 40, octave: 1,
          voiceAPattern: [2, 4, 0, 6, 3, 5, 7, 1, 4, 0, 6, 2, 5, 7, 1, 3, 6], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [5, 7, 3, 1, 4, 6, 2, 0, 7, 3, 1, 4, 6], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsRich, everySteps: 24, lengthRatio: 22, instrument: 'pads-light' },
          drone: { voices: droneRich, everySteps: 96, lengthRatio: 55, instrument: 'drone-light' },
          sparkle: {
            everySteps: 6, atStep: 3, indexStride: 5, octaveOffset: 2, durationSec: 0.45, instrument: 'sparkle',
            echoes: [{ delaySec: 0.45, velocity: 0.45 }, { delaySec: 0.9, velocity: 0.3 }, { delaySec: 1.35, velocity: 0.15 }],
          },
        }),
        section({
          lengthSteps: 63, stepDur: 0.52, scale, transposeValues: [1, 4, 3, 0, 2], transposeEverySteps: 44, octave: 0,
          voiceAPattern: [3, 6, 0, 4, 7, 1, 5, 2, 6, 3, 7, 0, 4, 1, 6, 2, 5, 0, 4], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [4, 1, 6, 3, 0, 5, 2, 7, 4, 1, 6, 3, 0, 5], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsRich, everySteps: 32, lengthRatio: 36, instrument: 'pads-heavy' },
          drone: { voices: droneRich, everySteps: 64, lengthRatio: 70, instrument: 'drone-heavy' },
          sparkle: {
            everySteps: 12, atStep: 7, indexStride: 6, octaveOffset: 2, durationSec: 0.5, instrument: 'sparkle',
            echoes: [{ delaySec: 0.6, velocity: 0.35 }, { delaySec: 1.2, velocity: 0.18 }],
          },
        }),
      ];
    })() },
  },
  {
    // 5分・三部構成(各部さらに3区間)。Driftwheel と同じ骨格を、Aエオリアン・別テンポ・
    // 各区間の音型を裏返した進行で変奏する。
    kind: 'suite',
    name: 'Antiphon',
    instruments: [
      { kind: 'tone', id: 'voiceA-heavy', params: { wave: 'triangle', level: 0.032, attackSec: 0.05, pan: 0 } },
      { kind: 'tone', id: 'voiceA-heavy-harmonic', params: { wave: 'sine', level: 0.01, attackSec: 0.05, pan: 0 } },
      { kind: 'tone', id: 'voiceA-light', params: { wave: 'sine', level: 0.028, attackSec: 0.012, pan: 0 } },
      { kind: 'tone', id: 'voiceA-light-harmonic', params: { wave: 'triangle', level: 0.008, attackSec: 0.012, pan: 0 } },
      { kind: 'tone', id: 'voiceB-heavy', params: { wave: 'sine', level: 0.024, attackSec: 0.06, pan: 0 } },
      { kind: 'tone', id: 'voiceB-light', params: { wave: 'triangle', level: 0.02, attackSec: 0.018, pan: 0 } },
      { kind: 'tone', id: 'pads-heavy', params: { wave: 'triangle', level: 0.015, attackSec: 5.5, pan: 0 } },
      { kind: 'tone', id: 'pads-light', params: { wave: 'triangle', level: 0.011, attackSec: 2.4, pan: 0 } },
      { kind: 'tone', id: 'drone-heavy', params: { wave: 'sine', level: 0.022, attackSec: 7, pan: 0 } },
      { kind: 'tone', id: 'drone-light', params: { wave: 'sine', level: 0.015, attackSec: 4, pan: 0 } },
      { kind: 'tone', id: 'sparkle', params: { wave: 'sine', level: 0.011, attackSec: 0.01, pan: 0 } },
    ],
    params: { sections: (() => {
      const scale = [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392, 440]; // A3, B3, C4, D4, E4, F4, G4, A4
      const padsBase = [
        [110, 146.83, 196, 293.66],
        [123.47, 164.81, 220, 329.63],
        [130.81, 174.61, 246.94, 349.23],
        [146.83, 196, 261.63, 392],
      ];
      const padsRich = [
        [110, 146.83, 196, 293.66, 440],
        [123.47, 164.81, 220, 329.63, 493.88],
        [130.81, 174.61, 246.94, 349.23, 523.25],
        [146.83, 196, 261.63, 392, 587.33],
      ];
      const droneBase = [{ pitch: 55, velocity: 1 }, { pitch: 110, velocity: 0.6 }]; // A1, A2
      const droneRich = [{ pitch: 55, velocity: 1 }, { pitch: 110, velocity: 0.6 }, { pitch: 82.41, velocity: 0.4 }]; // + E2
      const sparkleLight = {
        everySteps: 8, atStep: 5, indexStride: 5, octaveOffset: 2, durationSec: 0.4, instrument: 'sparkle',
        echoes: [{ delaySec: 0.5, velocity: 0.4 }, { delaySec: 1.0, velocity: 0.2 }],
      };
      return [
        // 第一部(ゆっくり)
        section({
          lengthSteps: 69, stepDur: 0.48, scale, transposeValues: [0, -2, 1], transposeEverySteps: 52, octave: -1,
          voiceAPattern: [7, 3, 0, 6, 2, 5, 1, 7, 3, 6, 2, 4, 0], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [6, 2, 5, 0, 4, 2, 6, 1, 5, 3, 7], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsBase, everySteps: 32, lengthRatio: 34, instrument: 'pads-heavy' },
          drone: { voices: droneBase, everySteps: 64, lengthRatio: 66, instrument: 'drone-heavy' },
          sparkle: null,
        }),
        section({
          lengthSteps: 69, stepDur: 0.48, scale, transposeValues: [-1, 0, 2], transposeEverySteps: 44, octave: 1,
          voiceAPattern: [4, 1, 7, 5, 3, 0, 6, 4, 2, 7, 5, 3, 1, 6, 4, 2, 0], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [4, 6, 1, 3, 5, 0, 2, 4, 6, 1, 3, 5, 7], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsBase, everySteps: 24, lengthRatio: 20, instrument: 'pads-light' },
          drone: { voices: droneBase, everySteps: 96, lengthRatio: 50, instrument: 'drone-light' },
          sparkle: sparkleLight,
        }),
        section({
          lengthSteps: 69, stepDur: 0.48, scale, transposeValues: [1, -1, 0, 3], transposeEverySteps: 46, octave: 0,
          voiceAPattern: [2, 7, 3, 0, 5, 1, 6, 2, 7, 4, 0, 5, 2, 7, 4, 1, 6, 3, 0], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [0, 3, 6, 1, 4, 7, 2, 5, 0, 3, 6, 1, 4, 7], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsBase, everySteps: 32, lengthRatio: 34, instrument: 'pads-heavy' },
          drone: { voices: droneBase, everySteps: 64, lengthRatio: 66, instrument: 'drone-heavy' },
          sparkle: null,
        }),
        // 第二部(軽快で速い)
        section({
          lengthSteps: 138, stepDur: 0.24, scale, transposeValues: [0, 1, -1, 2], transposeEverySteps: 22, octave: 1,
          voiceAPattern: [3, 7, 5, 2, 0, 6, 4, 1, 7, 5, 3, 6, 4, 2, 0], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [2, 4, 7, 5, 1, 3, 6, 0, 2, 4, 7], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsBase, everySteps: 16, lengthRatio: 14, instrument: 'pads-light' },
          drone: { voices: droneBase, everySteps: 48, lengthRatio: 30, instrument: 'drone-light' },
          sparkle: sparkleLight,
        }),
        section({
          lengthSteps: 138, stepDur: 0.24, scale, transposeValues: [-2, 0, 1], transposeEverySteps: 26, octave: -1,
          voiceAPattern: [4, 7, 2, 5, 0, 3, 6, 1, 4, 7, 2, 5, 0], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [7, 4, 1, 6, 3, 0, 5, 2, 7, 4, 1, 6, 3, 0, 5, 2, 7], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsBase, everySteps: 24, lengthRatio: 20, instrument: 'pads-heavy' },
          drone: { voices: droneBase, everySteps: 48, lengthRatio: 40, instrument: 'drone-heavy' },
          sparkle: null,
        }),
        section({
          lengthSteps: 138, stepDur: 0.24, scale, transposeValues: [1, 0, -1, 2], transposeEverySteps: 19, octave: 0,
          voiceAPattern: [0, 7, 3, 6, 2, 5, 1, 4, 0, 7, 3, 6, 2, 5, 1, 4, 0], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [5, 1, 4, 0, 3, 6, 2, 5, 1, 4, 0, 3, 7], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsBase, everySteps: 16, lengthRatio: 14, instrument: 'pads-light' },
          drone: { voices: droneBase, everySteps: 64, lengthRatio: 30, instrument: 'drone-light' },
          sparkle: sparkleLight,
        }),
        // 第三部(第一部の変奏。パターンと和音を厚くする)
        section({
          lengthSteps: 69, stepDur: 0.48, scale, transposeValues: [0, -2, 1, 3], transposeEverySteps: 52, octave: -1,
          voiceAPattern: [7, 0, 4, 2, 6, 5, 1, 3, 7, 2, 6, 0, 4], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [7, 5, 3, 0, 4, 6, 2, 1, 5, 7, 3], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsRich, everySteps: 32, lengthRatio: 34, instrument: 'pads-heavy' },
          drone: { voices: droneRich, everySteps: 64, lengthRatio: 66, instrument: 'drone-heavy' },
          sparkle: {
            everySteps: 16, atStep: 9, indexStride: 7, octaveOffset: 2, durationSec: 0.5, instrument: 'sparkle',
            echoes: [{ delaySec: 0.6, velocity: 0.3 }],
          },
        }),
        section({
          lengthSteps: 69, stepDur: 0.48, scale, transposeValues: [-1, 0, 3, 2], transposeEverySteps: 44, octave: 1,
          voiceAPattern: [6, 3, 1, 7, 5, 2, 6, 0, 4, 1, 7, 5, 3, 6, 0, 4, 2], voiceAInstrument: 'voiceA-light', voiceAHarmonicInstrument: 'voiceA-light-harmonic',
          voiceBPattern: [6, 4, 1, 3, 7, 0, 2, 6, 4, 1, 3, 7, 5], voiceBInstrument: 'voiceB-light',
          pads: { chords: padsRich, everySteps: 24, lengthRatio: 22, instrument: 'pads-light' },
          drone: { voices: droneRich, everySteps: 96, lengthRatio: 55, instrument: 'drone-light' },
          sparkle: {
            everySteps: 6, atStep: 3, indexStride: 5, octaveOffset: 2, durationSec: 0.45, instrument: 'sparkle',
            echoes: [{ delaySec: 0.45, velocity: 0.45 }, { delaySec: 0.9, velocity: 0.3 }, { delaySec: 1.35, velocity: 0.15 }],
          },
        }),
        section({
          lengthSteps: 69, stepDur: 0.48, scale, transposeValues: [1, 3, -1, 0, 2], transposeEverySteps: 46, octave: 0,
          voiceAPattern: [4, 0, 5, 2, 6, 1, 4, 0, 7, 3, 6, 2, 5, 1, 7, 4, 0, 6, 3], voiceAInstrument: 'voiceA-heavy', voiceAHarmonicInstrument: 'voiceA-heavy-harmonic',
          voiceBPattern: [5, 0, 3, 6, 1, 4, 7, 2, 5, 0, 3, 6, 1, 4], voiceBInstrument: 'voiceB-heavy',
          pads: { chords: padsRich, everySteps: 32, lengthRatio: 36, instrument: 'pads-heavy' },
          drone: { voices: droneRich, everySteps: 64, lengthRatio: 70, instrument: 'drone-heavy' },
          sparkle: {
            everySteps: 12, atStep: 7, indexStride: 6, octaveOffset: 2, durationSec: 0.5, instrument: 'sparkle',
            echoes: [{ delaySec: 0.6, velocity: 0.35 }, { delaySec: 1.2, velocity: 0.18 }],
          },
        }),
      ];
    })() },
  },
];
