// **仮設**: 雲の生成を追い込むあいだ、cloud-lab のスライダーと JSON へ出す定数の表。値の正本は
// 生成側の uniform(src/render/cloud の _KNOB)で、ここが持つのは id・表示名・置く行・可動域だけ。
// 追い込みが終わったら、この表ごと消して生成側を素の定数へ畳む。
import {
  CLOUD_TOP_BIAS_KNOB, CLOUD_TOP_LIFT_KNOB, CLOUD_TOP_RELIEF_KNOB, CONVECTION_GAIN_KNOB,
  COVERAGE_WIDTH_KNOB, COVERAGE_ONSET_KNOB, TRANSLUCENT_GAIN_KNOB, TRANSLUCENT_ONSET_KNOB,
} from '../../src/render/cloud/condensation';
import {
  CONVECTION_NOISE_AMPLITUDE_KNOB, HUMIDITY_BASE_KNOB, LIFT_HUMIDITY_KNOB, MEAN_CLOUDINESS_WEIGHT_KNOB,
  PRESSURE_BAND_AMPLITUDE_KNOB, TERRAIN_LIFT_GAIN_KNOB, UPPER_HUMIDITY_BASE_KNOB, UPPER_LIFT_HUMIDITY_KNOB,
  UPPER_MEAN_CLOUDINESS_WEIGHT_KNOB,
} from '../../src/render/cloud/weather-model';
import type { FloatUniform } from '../../src/render/tsl-types';

// つまみ 1 つ。id は JSON の鍵、row はスライダーを置く行の id、min/max/step はつまみの可動域。
export type CloudTuningKnob = {
  readonly id: string;
  readonly row: 'condense' | 'weather';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: FloatUniform;
};

// 並びは凝結(被覆 → 雲頂 → 薄い雲)、天気(湿度の底上げ → 上昇流 → 場の振幅)の順。
export const CLOUD_TUNING_KNOBS: readonly CloudTuningKnob[] = [
  { id: 'coverageOnset', row: 'condense', label: '被覆 効き始め',
    min: 0, max: 1, step: 0.005, value: COVERAGE_ONSET_KNOB },
  { id: 'coverageWidth', row: 'condense', label: '被覆 幅',
    min: 0.02, max: 1, step: 0.005, value: COVERAGE_WIDTH_KNOB },
  { id: 'convectionGain', row: 'condense', label: '対流の重み',
    min: 0, max: 3, step: 0.01, value: CONVECTION_GAIN_KNOB },
  { id: 'cloudTopLift', row: 'condense', label: '雲頂 上昇流',
    min: 0, max: 200, step: 1, value: CLOUD_TOP_LIFT_KNOB },
  { id: 'cloudTopRelief', row: 'condense', label: '雲頂 対流',
    min: 0, max: 20, step: 0.1, value: CLOUD_TOP_RELIEF_KNOB },
  { id: 'cloudTopBias', row: 'condense', label: '雲頂 底',
    min: -5, max: 10, step: 0.1, value: CLOUD_TOP_BIAS_KNOB },
  { id: 'translucentOnset', row: 'condense', label: '薄雲 しきい',
    min: 0, max: 1, step: 0.005, value: TRANSLUCENT_ONSET_KNOB },
  { id: 'translucentGain', row: 'condense', label: '薄雲 利得',
    min: 0, max: 5, step: 0.01, value: TRANSLUCENT_GAIN_KNOB },
  { id: 'humidityBase', row: 'weather', label: '湿度 底上げ',
    min: 0, max: 1, step: 0.001, value: HUMIDITY_BASE_KNOB },
  { id: 'meanCloudinessWeight', row: 'weather', label: '平年雲量の重み',
    min: 0, max: 1.5, step: 0.005, value: MEAN_CLOUDINESS_WEIGHT_KNOB },
  { id: 'upperHumidityBase', row: 'weather', label: '上層 底上げ',
    min: 0, max: 1, step: 0.001, value: UPPER_HUMIDITY_BASE_KNOB },
  { id: 'upperMeanCloudinessWeight', row: 'weather', label: '上層 平年雲量',
    min: 0, max: 1.5, step: 0.005, value: UPPER_MEAN_CLOUDINESS_WEIGHT_KNOB },
  { id: 'liftHumidity', row: 'weather', label: '上昇流→湿度',
    min: 0, max: 20, step: 0.1, value: LIFT_HUMIDITY_KNOB },
  { id: 'upperLiftHumidity', row: 'weather', label: '上昇流→上層',
    min: 0, max: 10, step: 0.05, value: UPPER_LIFT_HUMIDITY_KNOB },
  { id: 'terrainLiftGain', row: 'weather', label: '地形の上昇流',
    min: 0, max: 3, step: 0.01, value: TERRAIN_LIFT_GAIN_KNOB },
  { id: 'convectionNoiseAmplitude', row: 'weather', label: '対流の振幅',
    min: 0, max: 0.6, step: 0.005, value: CONVECTION_NOISE_AMPLITUDE_KNOB },
  { id: 'pressureBandAmplitude', row: 'weather', label: '気圧帯の振幅',
    min: 0, max: 24, step: 0.1, value: PRESSURE_BAND_AMPLITUDE_KNOB },
];

// いまのつまみの値(id → 値)。JSON 欄と撮影側が同じ形で読み書きする。
export function cloudTuningValues(): Record<string, number> {
  return Object.fromEntries(CLOUD_TUNING_KNOBS.map((knob) => [knob.id, knob.value.value]));
}
