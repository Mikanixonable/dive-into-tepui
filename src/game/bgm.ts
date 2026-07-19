export interface BgmTrack {
  stepDur: number;
  scale: number[];
  patA: number[];
  patB: number[];
  pads: number[][];
  drone: number[]; // e.g. [36.71, 73.42]
  toneA1: OscillatorType;
  toneA2: OscillatorType;
  toneB: OscillatorType;
}

// 5 different ambient minimal music tracks
export const BGM_TRACKS: BgmTrack[] = [
  {
    // Track 0: The Original (D-centered, 16 vs 12, slow)
    stepDur: 0.42,
    scale: [146.83, 164.81, 196.0, 220.0, 261.63, 293.66, 329.63, 392.0], // D3, E3, G3, A3, C4, D4, E4, G4
    patA: [0, 4, 2, 5, 3, 7, 2, 6, 0, 5, 3, 6, 2, 7, 4, 6], // 16 beats
    patB: [7, 3, 5, 2, 6, 4, 5, 3, 6, 2, 4, 5], // 12 beats
    pads: [
      [73.42, 98.0, 130.81, 196.0],
      [82.41, 110.0, 146.83, 220.0],
      [98.0, 130.81, 174.61, 261.63],
      [110.0, 146.83, 196.0, 293.66]
    ],
    drone: [36.71, 73.42], // D1, D2
    toneA1: 'sine',
    toneA2: 'triangle',
    toneB: 'triangle',
  },
  {
    // Track 1: Ethereal (F Lydian-ish, 15 vs 11, slightly slower, very airy)
    stepDur: 0.5,
    scale: [174.61, 196.0, 220.0, 246.94, 261.63, 329.63, 349.23, 392.0], // F3, G3, A3, B3, C4, E4, F4, G4
    patA: [0, 2, 4, 5, 7, 4, 2, 3, 1, 0, 3, 6, 5, 2, 1], // 15 beats
    patB: [7, 5, 2, 1, 3, 6, 4, 2, 0, 3, 5], // 11 beats
    pads: [
      [87.31, 130.81, 174.61, 261.63], // F2, C3, F3, C4
      [98.00, 146.83, 196.00, 293.66], // G2, D3, G3, D4
      [110.00, 164.81, 220.00, 329.63], // A2, E3, A3, E4
      [87.31, 146.83, 174.61, 293.66]
    ],
    drone: [43.65, 87.31], // F1, F2
    toneA1: 'triangle',
    toneA2: 'sine',
    toneB: 'sine',
  },
  {
    // Track 2: Deep Space / Dark (C Minor Pentatonic, 14 vs 9, faster step, darker tone)
    stepDur: 0.35,
    scale: [130.81, 155.56, 174.61, 196.0, 233.08, 261.63, 311.13, 349.23], // C3, Eb3, F3, G3, Bb3, C4, Eb4, F4
    patA: [0, 3, 2, 1, 4, 7, 6, 5, 3, 2, 0, 1, 4, 6], // 14 beats
    patB: [7, 4, 2, 0, 5, 3, 1, 6, 4], // 9 beats
    pads: [
      [65.41, 98.0, 130.81, 196.0],
      [77.78, 116.54, 155.56, 233.08],
      [87.31, 130.81, 174.61, 261.63],
      [65.41, 116.54, 130.81, 233.08]
    ],
    drone: [32.70, 65.41], // C1, C2
    toneA1: 'square',
    toneA2: 'triangle',
    toneB: 'sine',
  },
  {
    // Track 3: Sparkling Crystal (E Major Pentatonic, 7 vs 5, fast step, bright)
    stepDur: 0.28,
    scale: [164.81, 185.0, 207.65, 246.94, 277.18, 329.63, 369.99, 415.3], // E3, F#3, G#3, B3, C#4, E4, F#4, G#4
    patA: [0, 2, 4, 3, 6, 5, 7], // 7 beats
    patB: [7, 4, 2, 5, 1], // 5 beats
    pads: [
      [82.41, 123.47, 164.81, 246.94],
      [92.50, 138.59, 185.00, 277.18],
      [103.83, 155.56, 207.65, 311.13],
      [82.41, 138.59, 164.81, 277.18]
    ],
    drone: [41.20, 82.41], // E1, E2
    toneA1: 'sine',
    toneA2: 'sine',
    toneB: 'triangle',
  },
  {
    // Track 4: Suspended (A Dorian, 13 vs 8, very slow step, mysterious)
    stepDur: 0.6,
    scale: [110.0, 123.47, 130.81, 146.83, 164.81, 185.0, 196.0, 220.0], // A2, B2, C3, D3, E3, F#3, G3, A3
    patA: [0, 4, 2, 7, 5, 3, 6, 1, 0, 3, 5, 2, 4], // 13 beats
    patB: [7, 4, 1, 6, 3, 0, 5, 2], // 8 beats
    pads: [
      [55.00, 82.41, 110.0, 164.81],
      [61.74, 92.50, 123.47, 185.0],
      [65.41, 98.00, 130.81, 196.0],
      [73.42, 110.0, 146.83, 220.0]
    ],
    drone: [27.50, 55.00], // A0, A1
    toneA1: 'triangle',
    toneA2: 'square',
    toneB: 'triangle',
  }
];
