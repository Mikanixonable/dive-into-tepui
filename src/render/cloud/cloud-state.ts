import type { CloudEnvironment } from './cloud-environment';
import type { CloudSample } from './cloud-field-sample';
import type { WeatherForcingField } from './weather-forcing-field';
import type { WeatherSample } from './weather-model';

// 一つの absolute time / seed から作られた logical cloud state。GPU texture の所有権は持たない。
export interface CloudState {
  readonly absoluteTimeSeconds: number;
  readonly seed: number;
  readonly environment: CloudEnvironment;
  readonly forcing: WeatherForcingField;
  readonly field: CloudSample;
}

// 3つの描画経路へ渡す immutable な時刻 binding。field と一緒に渡すことで雲面・大気・影が別時刻を読む余地をなくす。
export interface CloudStateBinding {
  readonly absoluteTimeSeconds: number;
  readonly seed: number;
}

export function cloudStateAt(
  weather: WeatherSample, field: CloudSample, absoluteTimeSeconds: number, seed: number,
): CloudState {
  return {
    absoluteTimeSeconds,
    seed,
    environment: weather.environment,
    forcing: weather.forcing,
    field,
  };
}
