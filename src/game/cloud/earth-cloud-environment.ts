// 地球上の方向から対流雲の環境プロファイルを組む供給源。地表温・比湿・気温減率・対流圏の
// 深さ・地表フラックスを緯度で変える経年平均の近似で、赤道では深く湿った対流圏、高緯度では
// 浅く乾いた柱を返す。緯度は方向の y から取り、経度・海陸・季節・日変化はまだ読まない。

import type { Vec3 } from '../../math/vec3';
import {
  saturationSpecificHumidityOverIceKgPerKg,
  saturationSpecificHumidityOverLiquidKgPerKg,
} from '../../physics/cloud-thermodynamics';
import { createCloudEnvironmentProfile } from './cloud-environment';
import type {
  CloudEnvironmentLevelInput, CloudEnvironmentProfile,
} from './cloud-environment';

// プロファイルの上端は対流圏界面の 1 km 上。パーセル積分は全層で乾・湿断熱を下るので、
// 上端を高く取りすぎるとパーセル温度が飽和式の適用下限(110 K)を割る。
const PROFILE_TOP_ABOVE_TROPOPAUSE_M = 1_000;
const LEVEL_STEP_M = 250;
const SURFACE_PRESSURE_PA = 100_000;
// 圧力の減衰スケールハイト [m]。緯度での変化は二次的なので一定で近似する。
const PRESSURE_SCALE_HEIGHT_M = 8_400;

// 経年平均の地表温 [K]。年平均の緯度帯平均気温(赤道 ~300 K、極 ~255 K)を cosφ の1次で
// なぞる近似。
const SURFACE_TEMPERATURE_EQUATOR_K = 300;
const SURFACE_TEMPERATURE_POLE_K = 255;
// 対流圏界面の高さ [m]。熱帯 ~17 km、極 ~9 km の経年平均を cos²φ で繋ぐ近似。
const TROPOPAUSE_EQUATOR_M = 17_000;
const TROPOPAUSE_POLE_M = 9_000;
// 対流圏の気温減率 [K/km]。湿潤断熱に近い熱帯の 6.5 から、乾いた極気団でやや浅い 5.5 まで。
const LAPSE_RATE_EQUATOR_K_PER_KM = 6.5;
const LAPSE_RATE_POLE_K_PER_KM = 5.5;
// 地表の相対湿度(液水に対する)。熱帯海洋の ~0.8 から、乾いた極気団の ~0.6 まで。
// 比湿は飽和比湿から導くので、冷たい柱でも過飽和にならない。
const SURFACE_RELATIVE_HUMIDITY_EQUATOR = 0.8;
const SURFACE_RELATIVE_HUMIDITY_POLE = 0.6;
// 比湿の減衰が上層の飽和低下へ追い付かないよう、各層で止める上限(飽和比湿に対する比)。
const MAX_LEVEL_RELATIVE_HUMIDITY = 0.95;
// 飽和の上限を取る相の切り替え [K]。氷飽和式は 273.16 K まで、液水式は -45 °C からしか
// 当てられないので、凝固点を境に相を選ぶ。
const ICE_SATURATION_TOP_K = 273.15;
// 比湿の減衰スケールハイト [m]。湿った熱帯ほど湿りが高いところまで残る。
const HUMIDITY_SCALE_HEIGHT_EQUATOR_M = 2_200;
const HUMIDITY_SCALE_HEIGHT_POLE_M = 1_500;
// 地表の熱フラックス [W/m²]。海洋性の熱帯で潜熱 ~150 W/m²、雪氷圏の極で ~30 W/m² の
// 経年平均を cos²φ で繋ぐ近似。
const LATENT_HEAT_FLUX_EQUATOR_W_PER_M2 = 150;
const LATENT_HEAT_FLUX_POLE_W_PER_M2 = 30;
const SENSIBLE_HEAT_FLUX_EQUATOR_W_PER_M2 = 20;
const SENSIBLE_HEAT_FLUX_POLE_W_PER_M2 = 10;
const CLOUD_TOP_LONGWAVE_COOLING_K_PER_S = 1e-4;
// 上層の氷層を張る帯 [m]。対流圏界面直下 5〜1 km へ、雲頂の氷を乗せる層として置く。
const ICE_LAYER_DEPTH_BELOW_TROPOPAUSE_M = 5_000;
const ICE_LAYER_TOP_BELOW_TROPOPAUSE_M = 1_000;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 単位方向から、その地点の対流環境プロファイルを返す。返り値は呼ぶたびに新しく組まれた
// frozen なプロファイルで、同じ方向には常に同じ内容が返る。
export function earthConvectiveCloudEnvironmentAt(direction: Vec3): CloudEnvironmentProfile {
  // 方向の y が sin(緯度)。経度成分は経年平均では読まない。
  const sinLatitude = clamp(direction.y, -1, 1);
  const cosLatitude = Math.sqrt(1 - sinLatitude * sinLatitude);
  const cosLatitudeSq = cosLatitude * cosLatitude;
  const tropopauseM = TROPOPAUSE_POLE_M
    + (TROPOPAUSE_EQUATOR_M - TROPOPAUSE_POLE_M) * cosLatitudeSq;
  const surfaceTemperatureK = SURFACE_TEMPERATURE_POLE_K
    + (SURFACE_TEMPERATURE_EQUATOR_K - SURFACE_TEMPERATURE_POLE_K) * cosLatitude;
  const lapseRateKPerM = (LAPSE_RATE_POLE_K_PER_KM
    + (LAPSE_RATE_EQUATOR_K_PER_KM - LAPSE_RATE_POLE_K_PER_KM) * cosLatitudeSq) / 1_000;
  const surfaceRelativeHumidity = SURFACE_RELATIVE_HUMIDITY_POLE
    + (SURFACE_RELATIVE_HUMIDITY_EQUATOR - SURFACE_RELATIVE_HUMIDITY_POLE) * cosLatitudeSq;
  const surfaceSpecificHumidityKgPerKg = surfaceRelativeHumidity
    * saturationSpecificHumidityOverLiquidKgPerKg(surfaceTemperatureK, SURFACE_PRESSURE_PA);
  const humidityScaleHeightM = HUMIDITY_SCALE_HEIGHT_POLE_M
    + (HUMIDITY_SCALE_HEIGHT_EQUATOR_M - HUMIDITY_SCALE_HEIGHT_POLE_M) * cosLatitudeSq;

  const profileTopM = tropopauseM + PROFILE_TOP_ABOVE_TROPOPAUSE_M;
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let heightM = 0; heightM <= profileTopM; heightM += LEVEL_STEP_M) {
    const pressurePa = SURFACE_PRESSURE_PA * Math.exp(-heightM / PRESSURE_SCALE_HEIGHT_M);
    // 対流圏界面までは一定減率で下げ、上では等温の成層圏へ繋ぐ。
    const temperatureK = surfaceTemperatureK - lapseRateKPerM * Math.min(heightM, tropopauseM);
    const saturationSpecificHumidityKgPerKg = temperatureK <= ICE_SATURATION_TOP_K
      ? saturationSpecificHumidityOverIceKgPerKg(temperatureK, pressurePa)
      : saturationSpecificHumidityOverLiquidKgPerKg(temperatureK, pressurePa);
    levels.push({
      heightM,
      pressurePa,
      temperatureK,
      waterVaporSpecificHumidityKgPerKg: Math.min(
        surfaceSpecificHumidityKgPerKg * Math.exp(-heightM / humidityScaleHeightM),
        MAX_LEVEL_RELATIVE_HUMIDITY * saturationSpecificHumidityKgPerKg),
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      // 輸送の風は大気風モデルが担うので、層の風は供給系へ効かない代理値。
      eastWindMps: -5,
      northWindMps: 0,
      largeScaleVerticalVelocityMps: 0,
    });
  }
  return createCloudEnvironmentProfile({
    levels,
    surfaceSensibleHeatFluxWPerM2: SENSIBLE_HEAT_FLUX_POLE_W_PER_M2
      + (SENSIBLE_HEAT_FLUX_EQUATOR_W_PER_M2
        - SENSIBLE_HEAT_FLUX_POLE_W_PER_M2) * cosLatitudeSq,
    surfaceLatentHeatFluxWPerM2: LATENT_HEAT_FLUX_POLE_W_PER_M2
      + (LATENT_HEAT_FLUX_EQUATOR_W_PER_M2
        - LATENT_HEAT_FLUX_POLE_W_PER_M2) * cosLatitudeSq,
    cloudTopLongwaveCoolingKPerS: CLOUD_TOP_LONGWAVE_COOLING_K_PER_S,
    gravityWaveSource: null,
    upperIceLayerBottomM: tropopauseM - ICE_LAYER_DEPTH_BELOW_TROPOPAUSE_M,
    upperIceLayerTopM: tropopauseM - ICE_LAYER_TOP_BELOW_TROPOPAUSE_M,
  });
}
