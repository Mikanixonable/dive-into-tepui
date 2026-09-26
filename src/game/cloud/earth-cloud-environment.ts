// 地球上の方向から対流雲の環境プロファイルを組む供給源。地表温・比湿・気温減率・対流圏の
// 深さ・地表フラックスを緯度で変える経年平均の近似で、赤道では深く湿った対流圏、高緯度では
// 浅く乾いた柱を返す。気候源(気温・平年雲量・標高・陸らしさ)を受けるときはその値で
// 地表温・湿り・フラックスを変調し、経度・海陸の変化も表す。季節・日変化は年間平均の
// まま読まない。

import type { Vec3 } from '../../math/vec3';
import {
  saturationSpecificHumidityOverIceKgPerKg,
  saturationSpecificHumidityOverLiquidKgPerKg,
} from '../../physics/cloud-thermodynamics';
import { createCloudEnvironmentProfile } from './cloud-environment';
import type {
  CloudEnvironmentInput, CloudEnvironmentLevelInput, CloudEnvironmentProfile,
} from './cloud-environment';
import type { ClimateValues } from '../../render/cloud/climate-map';

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
// 地表から対流圏界面までの柱の深さの下限 [m]。界面の高度は海面基準で決まるので、地表が
// 高いほどその上の柱は浅い。高山でも界面直下の氷層帯が形を保つ下限。
const TROPOPAUSE_MIN_DEPTH_M = 6_000;
// 重力波源を置く帯 [deg]。中緯度の斜圧帯(|φ| 20〜60°)の内側 35〜45° で窓が全開になる
// 近似で、帯の内外では波の変位が滑らかに消える。地形・前線・ジェット streak といった
// 個別の波源は解像せず、緯度だけで強さを決める。
const WAVE_BAND_RAMP_IN_DEG = 20;
const WAVE_BAND_FULL_INNER_DEG = 35;
const WAVE_BAND_FULL_OUTER_DEG = 45;
const WAVE_BAND_RAMP_OUT_DEG = 60;
// 陸の乾きが地表の相対湿度へ掛かる最大の深さ。内陸沙漠の経年平均の地表相対湿度は
// 海洋の半分前後(サハラ ~0.3〜0.4)なので、乾き 1 で緯度値の半分まで下げる。
const SURFACE_DRYING_ON_LAND = 0.5;
// 比湿の減衰スケールハイトへの陸の乾きの効き。乾いた陸では湿りが地表近くに留まる。
const HUMIDITY_DEPTH_DRYING_ON_LAND = 0.3;
// 潜熱フラックスへの陸の乾きの効き。沙漠の年潜熱フラックスは海洋の数十分の一なので、
// 乾き 1 で 80% 落とす。
const LATENT_FLUX_LOSS_ON_DRY_LAND = 0.8;
// 顕熱フラックスへの陸の乾きの効き。乾いた地表では放射収支が蒸散でなく地熱・顕熱へ出る。
const SENSIBLE_FLUX_GAIN_ON_DRY_LAND = 1.5;
// 全球の平年平均雲量(MODIS の全月・全球平均で ≈0.67)。これを中立とみなし、雲量の多寡で
// 湿りの柱の深さを前後させる。
const MEAN_GLOBAL_CLOUDINESS = 0.67;
const HUMIDITY_DEPTH_GAIN_ON_CLOUD = 0.3;
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
// 傾斜上昇域(前線・雨帯に沿う斜めの湿潤層)が張る帯 [m]。下端は境界層の上、上端は
// 深い成層の雲が届く高さ — 対流圏界面−1 km より浅い所へ収める。
const SLANT_MOIST_LAYER_BOTTOM_M = 1_500;
const SLANT_MOIST_LAYER_TOP_M = 9_000;
// 傾斜上昇域の湿潤層の底上げ RH(対飽和比)。帯の強さ 0..1 で底上げ 0.4(背景の減衰値
// なみ)から MAX_LEVEL_RELATIVE_HUMIDITY(ほぼ飽和)まで上げる。
const SLANT_MOIST_LAYER_BASE_RELATIVE_HUMIDITY = 0.4;
// 気団の温度偏差が減衰する深さ [m]。暖気・寒気の流入は境界層〜中層に効く換算。
const AIR_MASS_TEMPERATURE_DEPTH_M = 4_000;
// 層の風を低層の値から上層の値へ混ぜる遷移帯 [m]。大気風モデルの地表付近・上層の
// 高さと同じ取り決め。
const LEVEL_WIND_BLEND_BOTTOM_M = 1_000;
const LEVEL_WIND_BLEND_TOP_M = 10_000;
// 地表の相対湿度へ足せる偏りの上下限。入力に掛かる総量を押さえてプロファイルが組める
// 範囲に留める。
const MIN_SURFACE_RELATIVE_HUMIDITY = 0.02;
const MAX_SURFACE_RELATIVE_HUMIDITY = 0.98;

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

// 方向の気候値を CPU 側の数値で答える口。画像がまだ届いていない・読めないときは
// null を返し、その地点の環境は緯度近似へ落ちる。
export interface EarthClimateSource {
  valuesAtCpu(direction: Vec3): ClimateValues | null;
}

// 緯度+気候の柱へ畳む、総観規模の天気の偏差。どの項も null を渡したとき 0 として扱われ、
// そのとき環境は緯度と気候値だけで決まる。
export interface EarthEnvironmentPerturbation {
  // 地表の気温偏差 [K]。暖気の流入で正、寒気の流入で負。気団の温度偏差として
  // AIR_MASS_TEMPERATURE_DEPTH_M の深さで減衰しながら層へ効く。
  readonly surfaceTemperatureShiftK: number;
  // 地表の相対湿度への加算の偏り。帯の加湿・眼の乾き・沈降の乾燥を畳んだもの。
  readonly surfaceRelativeHumidityBias: number;
  // 傾斜上昇域(前線・雨帯に沿う斜めの湿潤層)の強さ 0..1。
  readonly slantwiseMoistureStrength: number;
  // 上層の氷層帯の比湿への加算の偏り(対飽和比)。渦の上層流出で正、眼・沈降で負。
  readonly upperHumidityBias: number;
  // 大規模な鉛直流 [m/s]。上昇で正。層へは対流圏の中ほどが腹の放物線で写す。
  readonly largeScaleLiftMps: number;
  // 地表付近・上層の風 [m/s]。層へは LEVEL_WIND_BLEND 帯で線形に混ぜるので、
  // 風の鉛直差がそのままシアになる。
  readonly surfaceWindEastMps: number;
  readonly surfaceWindNorthMps: number;
  readonly upperWindEastMps: number;
  readonly upperWindNorthMps: number;
  // 深い気圧の谷の上での対流圏界面のたわみ [m](負で下がる)。
  readonly tropopauseShiftM: number;
}

// 単位方向と気候値と天気の偏差から、環境プロファイルへ渡す入力を組む。perturbation が
// null のときは緯度と気候値だけで決まる柱になる。
export function earthEnvironmentInputAt(
  direction: Vec3, climateSource: EarthClimateSource | null,
  perturbation: EarthEnvironmentPerturbation | null,
): CloudEnvironmentInput {
  const climate = climateSource?.valuesAtCpu(direction) ?? null;
  // 乾きの度合い 0..1。陸らしさに晴天さ(1−雲量)を掛けたもの。海上では地表の水が常に
  // 境界層を湿らせるので、乾きは陸の側へだけ掛ける。
  const surfaceDryness = climate === null
    ? 0
    : climate.landFraction * (1 - climate.meanCloudiness);
  const cloudiness = climate?.meanCloudiness ?? MEAN_GLOBAL_CLOUDINESS;
  // 方向の y が sin(緯度)。経度成分は気候源の値を通してだけ効く。
  const sinLatitude = clamp(direction.y, -1, 1);
  const cosLatitude = Math.sqrt(1 - sinLatitude * sinLatitude);
  const cosLatitudeSq = cosLatitude * cosLatitude;
  const tropopauseM = TROPOPAUSE_POLE_M
    + (TROPOPAUSE_EQUATOR_M - TROPOPAUSE_POLE_M) * cosLatitudeSq;
  // 界面の高度は海面基準で緯度に決まるので、地表からの深さは標高ぶん浅くなる。
  // 深い気圧の谷の上では攪乱のたわみぶん下がる。
  const tropopauseAboveSurfaceM = Math.max(
    tropopauseM - (climate?.elevationM ?? 0) + (perturbation?.tropopauseShiftM ?? 0),
    TROPOPAUSE_MIN_DEPTH_M);
  // 地表温は気候値があればそれを取り、無ければ緯度近似。気団の温度偏差は地表から
  // AIR_MASS_TEMPERATURE_DEPTH_M の深さで減衰する。
  const baseSurfaceTemperatureK = climate?.temperatureK ?? SURFACE_TEMPERATURE_POLE_K
    + (SURFACE_TEMPERATURE_EQUATOR_K - SURFACE_TEMPERATURE_POLE_K) * cosLatitude;
  const surfaceTemperatureShiftK = perturbation?.surfaceTemperatureShiftK ?? 0;
  const lapseRateKPerM = (LAPSE_RATE_POLE_K_PER_KM
    + (LAPSE_RATE_EQUATOR_K_PER_KM - LAPSE_RATE_POLE_K_PER_KM) * cosLatitudeSq) / 1_000;
  // 標高ぶん表面圧を下げる。気候源を持たないときは海面と同じ。
  const surfacePressurePa = SURFACE_PRESSURE_PA
    * Math.exp(-(climate?.elevationM ?? 0) / PRESSURE_SCALE_HEIGHT_M);
  const surfaceRelativeHumidity = clamp(
    (SURFACE_RELATIVE_HUMIDITY_POLE
      + (SURFACE_RELATIVE_HUMIDITY_EQUATOR - SURFACE_RELATIVE_HUMIDITY_POLE) * cosLatitudeSq)
      * (1 - SURFACE_DRYING_ON_LAND * surfaceDryness)
      + (perturbation?.surfaceRelativeHumidityBias ?? 0),
    MIN_SURFACE_RELATIVE_HUMIDITY, MAX_SURFACE_RELATIVE_HUMIDITY);
  // 地表温 = ベースの柱 + 気団の温度偏差。
  const surfaceTemperatureK = baseSurfaceTemperatureK + surfaceTemperatureShiftK;
  const surfaceSaturationKgPerKg = surfaceTemperatureK <= ICE_SATURATION_TOP_K
    ? saturationSpecificHumidityOverIceKgPerKg(surfaceTemperatureK, surfacePressurePa)
    : saturationSpecificHumidityOverLiquidKgPerKg(surfaceTemperatureK, surfacePressurePa);
  // パーセルの露点診断は液水飽和式の下限(−45 °C)までしか届かない。それより乾いた
  // 極地の柱でもプロファイルが組めるよう、地表比湿は露点 −45 °C 相当の分圧にわずかな
  // 余裕を持たせて止める。
  const minSurfaceSpecificHumidityKgPerKg = saturationSpecificHumidityOverLiquidKgPerKg(
    273.15 - 45 + 0.001, surfacePressurePa);
  const surfaceSpecificHumidityKgPerKg = Math.max(
    surfaceRelativeHumidity * surfaceSaturationKgPerKg,
    minSurfaceSpecificHumidityKgPerKg);
  const humidityScaleHeightM = (HUMIDITY_SCALE_HEIGHT_POLE_M
    + (HUMIDITY_SCALE_HEIGHT_EQUATOR_M - HUMIDITY_SCALE_HEIGHT_POLE_M) * cosLatitudeSq)
    * (1 - HUMIDITY_DEPTH_DRYING_ON_LAND * surfaceDryness
      + HUMIDITY_DEPTH_GAIN_ON_CLOUD * (cloudiness - MEAN_GLOBAL_CLOUDINESS));

  // 傾斜上昇域の湿潤層。帯の強さに比例した下限 RH を 1.5 km〜対流圏界面−1 km に張る。
  const slantMoistStrength = perturbation?.slantwiseMoistureStrength ?? 0;
  const slantMoistTopM = Math.min(
    SLANT_MOIST_LAYER_TOP_M, tropopauseAboveSurfaceM - ICE_LAYER_TOP_BELOW_TROPOPAUSE_M);
  const inSlantMoistLayer = slantMoistStrength > 0 && slantMoistTopM > SLANT_MOIST_LAYER_BOTTOM_M;
  const slantMoistRelativeHumidity = SLANT_MOIST_LAYER_BASE_RELATIVE_HUMIDITY
    + (MAX_LEVEL_RELATIVE_HUMIDITY - SLANT_MOIST_LAYER_BASE_RELATIVE_HUMIDITY)
      * clamp(slantMoistStrength, 0, 1);
  const upperHumidityBias = perturbation?.upperHumidityBias ?? 0;
  const largeScaleLiftMps = perturbation?.largeScaleLiftMps ?? 0;
  const upperIceLayerBottomM = tropopauseAboveSurfaceM - ICE_LAYER_DEPTH_BELOW_TROPOPAUSE_M;
  const upperIceLayerTopM = tropopauseAboveSurfaceM - ICE_LAYER_TOP_BELOW_TROPOPAUSE_M;

  const profileTopM = tropopauseAboveSurfaceM + PROFILE_TOP_ABOVE_TROPOPAUSE_M;
  const waveWeight = waveBandWeight(Math.abs(Math.asin(sinLatitude)));
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let heightM = 0; heightM <= profileTopM; heightM += LEVEL_STEP_M) {
    const pressurePa = surfacePressurePa * Math.exp(-heightM / PRESSURE_SCALE_HEIGHT_M);
    // 対流圏界面までは一定減率で下げ、上では等温の成層圏へ繋ぐ。気団の温度偏差は
    // AIR_MASS_TEMPERATURE_DEPTH_M の深さで減衰する。
    const temperatureK = surfaceTemperatureK - lapseRateKPerM
      * Math.min(heightM, tropopauseAboveSurfaceM)
      - surfaceTemperatureShiftK * (1 - Math.exp(-heightM / AIR_MASS_TEMPERATURE_DEPTH_M));
    const saturationSpecificHumidityKgPerKg = temperatureK <= ICE_SATURATION_TOP_K
      ? saturationSpecificHumidityOverIceKgPerKg(temperatureK, pressurePa)
      : saturationSpecificHumidityOverLiquidKgPerKg(temperatureK, pressurePa);
    const inMoistLayer = waveWeight > 0
      && heightM >= WAVE_MOIST_LAYER_BOTTOM_M && heightM <= WAVE_MOIST_LAYER_TOP_M;
    // 減衰プロファイルを湿潤中層では下限 RH へ底上げする。下限は帯の外で減衰値と同じ
    // くらいへ滑らかに下がるので、帯の端で柱は連続的に乾く。
    const moistLayerRelativeHumidity = WAVE_MOIST_LAYER_BASE_RELATIVE_HUMIDITY
      + (MAX_LEVEL_RELATIVE_HUMIDITY - WAVE_MOIST_LAYER_BASE_RELATIVE_HUMIDITY) * waveWeight;
    // 層の湿り: 減衰プロファイルへ上限を掛け、湿潤中層・傾斜上昇域の下限 RH で底上げし、
    // 氷層帯へは上層の湿りの偏りを加算する。
    let waterVaporKgPerKg = Math.max(
      Math.min(
        surfaceSpecificHumidityKgPerKg * Math.exp(-heightM / humidityScaleHeightM),
        MAX_LEVEL_RELATIVE_HUMIDITY * saturationSpecificHumidityKgPerKg),
      inMoistLayer
        ? moistLayerRelativeHumidity * saturationSpecificHumidityKgPerKg
        : 0,
      inSlantMoistLayer
          && heightM >= SLANT_MOIST_LAYER_BOTTOM_M && heightM <= slantMoistTopM
        ? slantMoistRelativeHumidity * saturationSpecificHumidityKgPerKg
        : 0);
    if (upperHumidityBias !== 0
      && heightM >= upperIceLayerBottomM && heightM <= upperIceLayerTopM) {
      waterVaporKgPerKg = clamp(
        waterVaporKgPerKg + upperHumidityBias * saturationSpecificHumidityKgPerKg,
        0, MAX_LEVEL_RELATIVE_HUMIDITY * saturationSpecificHumidityKgPerKg);
    }
    // 大規模鉛直流は対流圏の中ほどが腹の放物線で写す。界面と地表では 0。
    const liftWindow = heightM <= 0 || heightM >= tropopauseAboveSurfaceM
      ? 0
      : 4 * (heightM / tropopauseAboveSurfaceM) * (1 - heightM / tropopauseAboveSurfaceM);
    // 層の風は低層から上層へ LEVEL_WIND_BLEND 帯で混ぜる。攪乱が無いときは供給系へ
    // 効かない代理値(輸送の風は大気風モデルが担う)。
    const windBlend = perturbation === null ? 0
      : clamp((heightM - LEVEL_WIND_BLEND_BOTTOM_M)
        / (LEVEL_WIND_BLEND_TOP_M - LEVEL_WIND_BLEND_BOTTOM_M), 0, 1);
    levels.push({
      heightM,
      pressurePa,
      temperatureK,
      waterVaporSpecificHumidityKgPerKg: waterVaporKgPerKg,
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: perturbation === null ? -5
        : perturbation.surfaceWindEastMps
          + (perturbation.upperWindEastMps - perturbation.surfaceWindEastMps) * windBlend,
      northWindMps: perturbation === null ? 0
        : perturbation.surfaceWindNorthMps
          + (perturbation.upperWindNorthMps - perturbation.surfaceWindNorthMps) * windBlend,
      largeScaleVerticalVelocityMps: largeScaleLiftMps * liftWindow,
    });
  }
  return {
    levels,
    surfaceSensibleHeatFluxWPerM2: (SENSIBLE_HEAT_FLUX_POLE_W_PER_M2
      + (SENSIBLE_HEAT_FLUX_EQUATOR_W_PER_M2
        - SENSIBLE_HEAT_FLUX_POLE_W_PER_M2) * cosLatitudeSq)
      * (1 + SENSIBLE_FLUX_GAIN_ON_DRY_LAND * surfaceDryness),
    surfaceLatentHeatFluxWPerM2: (LATENT_HEAT_FLUX_POLE_W_PER_M2
      + (LATENT_HEAT_FLUX_EQUATOR_W_PER_M2
        - LATENT_HEAT_FLUX_POLE_W_PER_M2) * cosLatitudeSq)
      * (1 - LATENT_FLUX_LOSS_ON_DRY_LAND * surfaceDryness),
    cloudTopLongwaveCoolingKPerS: CLOUD_TOP_LONGWAVE_COOLING_K_PER_S,
    gravityWaveSource: waveWeight > 0 ? {
      sourceHeightM: WAVE_SOURCE_HEIGHT_M,
      verticalDisplacementM: WAVE_MAX_VERTICAL_DISPLACEMENT_M * waveWeight,
      horizontalWavelengthM: WAVE_HORIZONTAL_WAVELENGTH_M,
      verticalWavelengthM: WAVE_VERTICAL_WAVELENGTH_M,
      propagationAzimuthRad: WAVE_PROPAGATION_AZIMUTH_RAD,
    } : null,
    upperIceLayerBottomM,
    upperIceLayerTopM,
  };
}

// 単位方向から、その地点の対流環境プロファイルを返す。climateSource がこの方向の気候値を
// 返すときは、地表温・表面圧・湿り・フラックスをそれで変調する。返り値は呼ぶたびに
// 新しく組まれた frozen なプロファイルで、同じ方向と同じ気候値には常に同じ内容が返る。
export function earthConvectiveCloudEnvironmentAt(
  direction: Vec3, climateSource: EarthClimateSource | null = null,
): CloudEnvironmentProfile {
  return createCloudEnvironmentProfile(earthEnvironmentInputAt(direction, climateSource, null));
}
