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
// 重力波源を置く帯 [deg]。中緯度の斜圧帯(|φ| 20〜60°)の内側 35〜45° で窓が全開になる
// 近似で、帯の内外では波の変位が滑らかに消える。地形・前線・ジェット streak といった
// 個別の波源は解像せず、緯度だけで強さを決める。
const WAVE_BAND_RAMP_IN_DEG = 20;
const WAVE_BAND_FULL_INNER_DEG = 35;
const WAVE_BAND_FULL_OUTER_DEG = 45;
const WAVE_BAND_RAMP_OUT_DEG = 60;
// 波源が載る湿潤中層 [m]。斜圧帯で持ち上げられた湿潤層を、層内の比湿を飽和比湿への
// 下限比へ底上げする形でしか表さない近似(暖気コンベヤベルトのような実形状は解像しない)。
// 波帯の内側では氷層の下端(対流圏界面−5 km ≧ 6 km)より常に低く、上層湿り診断を変えない。
const WAVE_MOIST_LAYER_BOTTOM_M = 2_500;
const WAVE_MOIST_LAYER_TOP_M = 5_000;
// 湿潤層の底上げ RH(対飽和比)。帯の重み w で 0.4(減衰プロファイル並み)から
// MAX_LEVEL_RELATIVE_HUMIDITY(ほぼ飽和)まで上げ、波の持ち上げで凝結に届く湿りを保つ。
const WAVE_MOIST_LAYER_BASE_RELATIVE_HUMIDITY = 0.4;
// 波源入力。源高は湿潤中層の中、変位は帯の重みで強弱(線形閉包の上限 = 短い方の波長の
// 10% を常に下回る)。水平波長は undulatus の典型的な範囲(数〜数十 km)の内側。
// 伝播方位は西向き(π)の固定値 — 地面固定の波源が作る後退波(偏西風へ向かって上流へ
// 伝播する山岳波・地形波)の近似で、物質風(中緯度では東流)と位相速度が逆になる配置。
const WAVE_SOURCE_HEIGHT_M = 3_500;
const WAVE_MAX_VERTICAL_DISPLACEMENT_M = 400;
const WAVE_HORIZONTAL_WAVELENGTH_M = 12_000;
const WAVE_VERTICAL_WAVELENGTH_M = 6_000;
const WAVE_PROPAGATION_AZIMUTH_RAD = Math.PI;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 端で滑らかに 0 へ落ちる帯の重み。20〜35° で 0→1、35〜45° で 1、45〜60° で 1→0。
function waveBandWeight(absLatitudeRad: number): number {
  const degrees = absLatitudeRad * 180 / Math.PI;
  const smooth = (low: number, high: number, value: number): number => {
    const t = clamp((value - low) / (high - low), 0, 1);
    return t * t * (3 - 2 * t);
  };
  return smooth(WAVE_BAND_RAMP_IN_DEG, WAVE_BAND_FULL_INNER_DEG, degrees)
    * (1 - smooth(WAVE_BAND_FULL_OUTER_DEG, WAVE_BAND_RAMP_OUT_DEG, degrees));
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
  const waveWeight = waveBandWeight(Math.abs(Math.asin(sinLatitude)));
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let heightM = 0; heightM <= profileTopM; heightM += LEVEL_STEP_M) {
    const pressurePa = SURFACE_PRESSURE_PA * Math.exp(-heightM / PRESSURE_SCALE_HEIGHT_M);
    // 対流圏界面までは一定減率で下げ、上では等温の成層圏へ繋ぐ。
    const temperatureK = surfaceTemperatureK - lapseRateKPerM * Math.min(heightM, tropopauseM);
    const saturationSpecificHumidityKgPerKg = temperatureK <= ICE_SATURATION_TOP_K
      ? saturationSpecificHumidityOverIceKgPerKg(temperatureK, pressurePa)
      : saturationSpecificHumidityOverLiquidKgPerKg(temperatureK, pressurePa);
    const inMoistLayer = waveWeight > 0
      && heightM >= WAVE_MOIST_LAYER_BOTTOM_M && heightM <= WAVE_MOIST_LAYER_TOP_M;
    // 減衰プロファイルを湿潤中層では下限 RH へ底上げする。下限は帯の外で減衰値と同じ
    // くらいへ滑らかに下がるので、帯の端で柱は連続的に乾く。
    const moistLayerRelativeHumidity = WAVE_MOIST_LAYER_BASE_RELATIVE_HUMIDITY
      + (MAX_LEVEL_RELATIVE_HUMIDITY - WAVE_MOIST_LAYER_BASE_RELATIVE_HUMIDITY) * waveWeight;
    levels.push({
      heightM,
      pressurePa,
      temperatureK,
      waterVaporSpecificHumidityKgPerKg: Math.max(
        Math.min(
          surfaceSpecificHumidityKgPerKg * Math.exp(-heightM / humidityScaleHeightM),
          MAX_LEVEL_RELATIVE_HUMIDITY * saturationSpecificHumidityKgPerKg),
        inMoistLayer
          ? moistLayerRelativeHumidity * saturationSpecificHumidityKgPerKg
          : 0),
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
    gravityWaveSource: waveWeight > 0 ? {
      sourceHeightM: WAVE_SOURCE_HEIGHT_M,
      verticalDisplacementM: WAVE_MAX_VERTICAL_DISPLACEMENT_M * waveWeight,
      horizontalWavelengthM: WAVE_HORIZONTAL_WAVELENGTH_M,
      verticalWavelengthM: WAVE_VERTICAL_WAVELENGTH_M,
      propagationAzimuthRad: WAVE_PROPAGATION_AZIMUTH_RAD,
    } : null,
    upperIceLayerBottomM: tropopauseM - ICE_LAYER_DEPTH_BELOW_TROPOPAUSE_M,
    upperIceLayerTopM: tropopauseM - ICE_LAYER_TOP_BELOW_TROPOPAUSE_M,
  });
}
