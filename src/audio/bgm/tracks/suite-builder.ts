// kind: 'suite' の曲を組み立てる補助。パルス声部の倍音比・音長比・発音オフセットは
// phasing 系の全トラックで共通の値なので、ここへ集めて section() の呼び出し側は
// 緩急・音域・音色を作る値だけを書けばよいようにする。
import { DroneLayer, PadLayer, PhasingParams, SparkleLayer, SuiteSection } from './types';

const VOICE_A_LENGTH_RATIO = 1.3;
const VOICE_A_HARMONIC_RATIO = 2.003;
const VOICE_A_HARMONIC_LENGTH_RATIO = 0.7;
const VOICE_B_LENGTH_RATIO = 1.1;
const VOICE_B_STEP_OFFSET = 0.5;

interface SectionSpec {
  lengthSteps: number;
  stepDur: number;
  scale: number[];
  transposeValues: number[];
  transposeEverySteps: number;
  octave: number;
  voiceAPattern: number[];
  voiceAInstrument: string;
  voiceAHarmonicInstrument: string;
  voiceBPattern: number[];
  voiceBInstrument: string;
  pads: Pick<PadLayer, 'chords' | 'everySteps' | 'lengthRatio'> & { instrument: string };
  drone: Pick<DroneLayer, 'voices' | 'everySteps' | 'lengthRatio'> & { instrument: string };
  sparkle: SparkleLayer | null;
}

export function section(spec: SectionSpec): SuiteSection {
  const params: PhasingParams = {
    stepDur: spec.stepDur,
    scale: spec.scale,
    transpose: { values: spec.transposeValues, everySteps: spec.transposeEverySteps },
    octave: { values: [spec.octave], everySteps: 1 },
    voiceA: {
      pattern: spec.voiceAPattern,
      instrument: spec.voiceAInstrument,
      lengthRatio: VOICE_A_LENGTH_RATIO,
      stepOffset: 0,
      harmonic: {
        ratio: VOICE_A_HARMONIC_RATIO,
        instrument: spec.voiceAHarmonicInstrument,
        lengthRatio: VOICE_A_HARMONIC_LENGTH_RATIO,
      },
    },
    voiceB: {
      pattern: spec.voiceBPattern,
      instrument: spec.voiceBInstrument,
      lengthRatio: VOICE_B_LENGTH_RATIO,
      stepOffset: VOICE_B_STEP_OFFSET,
      harmonic: null,
    },
    pads: spec.pads,
    drone: spec.drone,
    sparkle: spec.sparkle,
  };
  return { params, lengthSteps: spec.lengthSteps };
}
