// 地球上の任意の方向・時刻で、気団・渦・地形を含んだ環境プロファイルを返す供給源。
// 総観規模の天気(気圧の谷・釣り合い風・気団の風上遡及・地形の強制上昇)を CPU で評価し、
// 緯度+気候の柱へ偏差として畳む。渦の眼壁・雨帯・上層流出は湿潤度・上昇・対流圏界面の
// たわみへ、気団の境界(前線・雨帯)は傾斜上昇域の湿潤層へ、地形の風上/風下は強制上昇と
// 乾燥へ写す。層の風は地表付近と上層の実風を混ぜるので、風の鉛直差(シア)も環境へ載る。

import { createCloudEnvironmentProfile } from './cloud-environment';
import { earthEnvironmentInputAt } from './earth-cloud-environment';
import {
  ANVIL_HUMIDITY, BAND_HUMIDITY, SURFACE_EYE_DRYNESS, SURFACE_LIFT_HUMIDITY,
  SURFACE_SUBSIDENCE_DRYING, UPPER_EYE_DRYNESS, UPPER_LIFT_HUMIDITY,
  UPPER_SUBSIDENCE_DRYING, WARM_HUMIDITY, weatherAtCpu,
} from '../../render/cloud/weather-model';
import type { Vec3 } from '../../math/vec3';
import type { CloudEnvironmentProfile } from './cloud-environment';
import type { EarthClimateSource, EarthEnvironmentPerturbation } from './earth-cloud-environment';
import type { WeatherSampleCpu } from '../../render/cloud/weather-model';

// 気団の暖かさが地表温を動かす換算 [K/rad]。warmth は出身緯度と現在緯度の差(温帯で
// 0.1〜0.3 rad 程度)で、15° 緯度差の気団で地表温を数 K 動かす程度に取る。
const SURFACE_TEMPERATURE_SHIFT_PER_WARMTH_RAD = 15;
const MAX_SURFACE_TEMPERATURE_SHIFT_K = 8;
// 地表の湿りの偏差が相対湿度へ写る係数。weather-model が移流後の湿度へ足し引きする
// 偏差(0..1 の場)と同じ利得で組み、相対湿度へ加算で写す。
const MAX_SURFACE_HUMIDITY_BIAS = 0.5;
const MAX_SURFACE_HUMIDITY_BIAS_DRY = -0.45;
// 上層の湿りの偏差が氷層帯の比湿へ写る係数(対飽和比の加算)。上層流出で加湿、眼と
// 沈降で乾燥。
const MAX_UPPER_HUMIDITY_BIAS = 0.6;
const MAX_UPPER_HUMIDITY_BIAS_DRY = -0.6;
// 深い気圧の谷の上で対流圏界面がたわむ高さ [m/hPa]。温帯低気圧の界面低下は数百 m〜
// 2 km の桁なので、最深 30 hPa で ~1.5 km 下げる換算。
const TROPOPAUSE_DROP_M_PER_HPA = 50;
const MAX_TROPOPAUSE_DROP_M = 2_000;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 天気の偏差を、環境プロファイルの攪乱へ写す。
function perturbationFromWeather(weather: WeatherSampleCpu): EarthEnvironmentPerturbation {
  // 地表付近の湿りの偏差。暖気の流入・帯の加湿・金床の湿り・上昇の加湿・沈降の乾燥・
  // 眼の乾きを、地表の相対湿度への加算として畳む。利得は天気の湿度場のものと同じ系列。
  const surfaceHumidityBias = weather.warmthRad * WARM_HUMIDITY
    + weather.bandStrength * BAND_HUMIDITY
    + weather.anvilStrength * ANVIL_HUMIDITY
    + Math.max(weather.liftMps, 0) * SURFACE_LIFT_HUMIDITY
    + Math.min(weather.liftMps, 0) * SURFACE_SUBSIDENCE_DRYING
    - weather.eyeStrength * SURFACE_EYE_DRYNESS;
  // 上層の湿りの偏差。上昇の加湿と金床の流出で湿らせ、眼と沈降で乾かす。
  const upperHumidityBias = Math.max(weather.liftMps, 0) * UPPER_LIFT_HUMIDITY
    + Math.min(weather.liftMps, 0) * UPPER_SUBSIDENCE_DRYING
    + weather.anvilStrength * ANVIL_HUMIDITY
    - weather.eyeStrength * UPPER_EYE_DRYNESS;
  return {
    surfaceTemperatureShiftK: clamp(
      weather.warmthRad * SURFACE_TEMPERATURE_SHIFT_PER_WARMTH_RAD,
      -MAX_SURFACE_TEMPERATURE_SHIFT_K, MAX_SURFACE_TEMPERATURE_SHIFT_K),
    surfaceRelativeHumidityBias: clamp(
      surfaceHumidityBias, MAX_SURFACE_HUMIDITY_BIAS_DRY, MAX_SURFACE_HUMIDITY_BIAS),
    slantwiseMoistureStrength: weather.bandStrength,
    upperHumidityBias: clamp(
      upperHumidityBias, MAX_UPPER_HUMIDITY_BIAS_DRY, MAX_UPPER_HUMIDITY_BIAS),
    largeScaleLiftMps: weather.liftMps,
    surfaceWindEastMps: weather.surfaceWindEastMps,
    surfaceWindNorthMps: weather.surfaceWindNorthMps,
    upperWindEastMps: weather.upperWindEastMps,
    upperWindNorthMps: weather.upperWindNorthMps,
    tropopauseShiftM: clamp(
      weather.cycloneDropHpa * TROPOPAUSE_DROP_M_PER_HPA, -MAX_TROPOPAUSE_DROP_M, 0),
  };
}

// 単位方向と時刻から、その地点の環境プロファイルを返す。climateSource がこの方向の
// 気候値を返すときは地表温・湿り・フラックスと地形の応答へ使う。timeSeconds は天気の
// 配置(渦の位置・発達)を決める時刻 [s]、surfaceRadiusM・rotationPeriodSeconds は
// 天体の半径 [m] と自転周期 [s]。返り値は呼ぶたびに新しく組まれた frozen な
// プロファイルで、同じ方向・時刻・気候値には常に同じ内容が返る。
export function earthGlobalEnvironmentAt(
  direction: Vec3,
  climateSource: EarthClimateSource | null,
  timeSeconds: number,
  surfaceRadiusM: number,
  rotationPeriodSeconds: number,
): CloudEnvironmentProfile {
  if (!Number.isFinite(timeSeconds)) throw new RangeError('timeSeconds must be finite');
  if (!Number.isFinite(surfaceRadiusM) || surfaceRadiusM <= 0) {
    throw new RangeError('surfaceRadiusM must be positive');
  }
  if (!Number.isFinite(rotationPeriodSeconds) || rotationPeriodSeconds <= 0) {
    throw new RangeError('rotationPeriodSeconds must be positive');
  }
  const weather = weatherAtCpu(
    direction, climateSource, timeSeconds, surfaceRadiusM, rotationPeriodSeconds);
  return createCloudEnvironmentProfile(
    earthEnvironmentInputAt(direction, climateSource, perturbationFromWeather(weather)));
}
