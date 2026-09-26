// 雲の表示導出が読む、再現可能な環境入力と診断。不変な入力と純粋な診断だけを持ち、
// 時刻・カメラ・GPU・モデル状態は持たない。描画へは導出した宣言だけを渡す。
// 全球循環モデルでも雲解像モデルでもない。
// 上層氷の湿り係数はイベント寿命系への入力で、氷の寿命そのものはここでは解かない。
// 高度依存の風は標本入力で、材料軌道の積分は輸送側が担う。
// パーセル診断は cloud-thermodynamics.ts に書かれた適用範囲に従う。柱の安定度は
// 仮温位温からの乾燥 Brunt–Väisälä 振動数、境界層の深さは 3 km 以下の最強の正勾配
// におけるプロファイル診断で、普遍的な境界層の定義ではない。波の位相は線形・
// 非回転 Boussinesq 内部波の分散関係を使い、凝結可否は源の変位で乾燥断熱持ち上げ
// した気塊が氷飽和へ届くかを見る — 潜熱・屈折・波の崩壊は省く。変位は両波長の
// 10% 未満(かつ 1 km 未満)に留めること。出典: WMO-No. 8 (2021), Annex 4.B;
// Bolton (1980), doi:10.1175/1520-0493(1980)108<1046:TCOEPT>2.0.CO;2;
// N² の定義: Durran (1990), doi:10.1175/1520-0469(1990)047<2152:ADVNTO>2.0.CO;2.

import {
  parcelBuoyancyProfile,
  saturationSpecificHumidityOverIceKgPerKg,
  saturationSpecificHumidityOverLiquidKgPerKg,
  virtualTemperatureK,
  type CloudProfileLevel,
} from '../../physics/cloud-thermodynamics';

const DRY_AIR_GAS_CONSTANT_J_PER_KG_K = 287.05;
const DRY_AIR_SPECIFIC_HEAT_J_PER_KG_K = 1004;
const WATER_TO_DRY_AIR_MOLAR_MASS_RATIO = 0.622;
const GRAVITY_M_PER_S2 = 9.80665;
const MAX_BOUNDARY_LAYER_SEARCH_HEIGHT_M = 3_000;
const MAX_WAVE_VERTICAL_DISPLACEMENT_M = 1_000;
const DRY_ADIABATIC_LAPSE_RATE_K_PER_M = GRAVITY_M_PER_S2 / DRY_AIR_SPECIFIC_HEAT_J_PER_KG_K;

export type CloudEnvironmentLevelInput = CloudProfileLevel & {
  readonly eastWindMps: number;
  readonly northWindMps: number;
  readonly largeScaleVerticalVelocityMps: number;
};

export interface GravityWaveSourceInput {
  readonly sourceHeightM: number;
  readonly verticalDisplacementM: number;
  readonly horizontalWavelengthM: number;
  readonly verticalWavelengthM: number;
  readonly propagationAzimuthRad: number;
};

export interface CloudEnvironmentInput {
  readonly levels: readonly CloudEnvironmentLevelInput[];
  readonly surfaceSensibleHeatFluxWPerM2: number;
  readonly surfaceLatentHeatFluxWPerM2: number;
  readonly cloudTopLongwaveCoolingKPerS: number;
  readonly gravityWaveSource: GravityWaveSourceInput | null;
  readonly upperIceLayerBottomM: number;
  readonly upperIceLayerTopM: number;
};

export interface CloudEnvironmentProfile {
  readonly levels: readonly CloudEnvironmentLevelInput[];
  readonly layerStability: readonly {
    readonly lowerHeightM: number;
    readonly upperHeightM: number;
    readonly buoyancyFrequencySquaredPerS2: number;
  }[];
  readonly columnWaterVaporKgPerM2: number;
  readonly boundaryLayer: {
    readonly depthM: number;
    readonly inversionBaseM: number | null;
    readonly inversionTopM: number | null;
    readonly potentialTemperatureIncreaseK: number;
  };
  readonly parcel: ReturnType<typeof parcelBuoyancyProfile>;
  readonly upperIceMoistureFactor: number;
  readonly surfaceSensibleHeatFluxWPerM2: number;
  readonly surfaceLatentHeatFluxWPerM2: number;
  readonly cloudTopLongwaveCoolingKPerS: number;
  readonly gravityWaveDriver: {
    readonly active: boolean;
    readonly cloudCondensationPossible: boolean;
    readonly sourceHeightM: number | null;
    readonly verticalDisplacementM: number;
    readonly liftedAirTemperatureK: number | null;
    readonly liftedAirPressurePa: number | null;
    readonly buoyancyFrequencySquaredPerS2: number;
    readonly restoringAccelerationMagnitudeMPerS2: number;
    readonly intrinsicAngularFrequencyRadPerS: number;
    readonly horizontalPhaseSpeedMps: number;
    readonly verticalPhaseSpeedMps: number;
    readonly eastwardPhaseSpeedMps: number;
    readonly northwardPhaseSpeedMps: number;
  };
};

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function virtualPotentialTemperatureK(level: CloudEnvironmentLevelInput): number {
  const virtualTemperature = virtualTemperatureK(
    level.temperatureK,
    level.waterVaporSpecificHumidityKgPerKg,
    level.liquidWaterMixingRatioKgPerKg,
    level.iceMixingRatioKgPerKg,
  );
  return virtualTemperature * (100_000 / level.pressurePa)
    ** (DRY_AIR_GAS_CONSTANT_J_PER_KG_K / DRY_AIR_SPECIFIC_HEAT_J_PER_KG_K);
}

function waterVaporDensityKgPerM3(level: CloudEnvironmentLevelInput): number {
  // 水蒸気の比湿を乾燥空気の混合比へ換算する。凝結物は気体の状態方程式に入らない
  // ので、液水・氷の質量を変えても rho_v は変わらない。
  const specificHumidity = level.waterVaporSpecificHumidityKgPerKg;
  const vaporMixingRatio = specificHumidity / (1 - specificHumidity);
  const dryAirDensity = level.pressurePa / (
    DRY_AIR_GAS_CONSTANT_J_PER_KG_K
      * level.temperatureK
      * (1 + vaporMixingRatio / WATER_TO_DRY_AIR_MOLAR_MASS_RATIO)
  );
  return dryAirDensity * vaporMixingRatio;
}

function validateInput(input: CloudEnvironmentInput): void {
  if (input.levels.length < 2) throw new RangeError('at least two environmental levels are required');
  for (let index = 0; index < input.levels.length; index += 1) {
    const level = input.levels[index]!;
    const prefix = `levels[${index}]`;
    requireFinite(level.heightM, `${prefix}.heightM`);
    requireFinite(level.temperatureK, `${prefix}.temperatureK`);
    requireFinite(level.pressurePa, `${prefix}.pressurePa`);
    requireFinite(level.waterVaporSpecificHumidityKgPerKg, `${prefix}.waterVaporSpecificHumidityKgPerKg`);
    requireFinite(level.liquidWaterMixingRatioKgPerKg, `${prefix}.liquidWaterMixingRatioKgPerKg`);
    requireFinite(level.iceMixingRatioKgPerKg, `${prefix}.iceMixingRatioKgPerKg`);
    requireFinite(level.eastWindMps, `${prefix}.eastWindMps`);
    requireFinite(level.northWindMps, `${prefix}.northWindMps`);
    requireFinite(level.largeScaleVerticalVelocityMps, `${prefix}.largeScaleVerticalVelocityMps`);
    if (level.heightM < 0 || level.temperatureK <= 0 || level.pressurePa <= 0) {
      throw new RangeError(`${prefix} has invalid height, temperature, or pressure`);
    }
    if (level.waterVaporSpecificHumidityKgPerKg < 0
      || level.waterVaporSpecificHumidityKgPerKg >= 1
      || level.liquidWaterMixingRatioKgPerKg < 0
      || level.iceMixingRatioKgPerKg < 0) {
      throw new RangeError(`${prefix} has invalid water content`);
    }
    if (index > 0) {
      const previous = input.levels[index - 1]!;
      if (level.heightM <= previous.heightM || level.pressurePa >= previous.pressurePa) {
        throw new RangeError('environment heights must increase while pressure decreases');
      }
    }
  }
  requireFinite(input.surfaceSensibleHeatFluxWPerM2, 'surfaceSensibleHeatFluxWPerM2');
  requireFinite(input.surfaceLatentHeatFluxWPerM2, 'surfaceLatentHeatFluxWPerM2');
  requireNonNegative(input.cloudTopLongwaveCoolingKPerS, 'cloudTopLongwaveCoolingKPerS');
  requireNonNegative(input.upperIceLayerBottomM, 'upperIceLayerBottomM');
  requireNonNegative(input.upperIceLayerTopM, 'upperIceLayerTopM');
  if (input.upperIceLayerTopM <= input.upperIceLayerBottomM) {
    throw new RangeError('upper ice layer top must exceed its bottom');
  }
  if (input.gravityWaveSource !== null) {
    requireNonNegative(input.gravityWaveSource.sourceHeightM, 'gravityWaveSource.sourceHeightM');
    requireNonNegative(input.gravityWaveSource.verticalDisplacementM, 'gravityWaveSource.verticalDisplacementM');
    if (input.gravityWaveSource.verticalDisplacementM > MAX_WAVE_VERTICAL_DISPLACEMENT_M) {
      throw new RangeError('gravity-wave displacement exceeds the linear closure range');
    }
    requirePositive(input.gravityWaveSource.horizontalWavelengthM, 'gravityWaveSource.horizontalWavelengthM');
    requirePositive(input.gravityWaveSource.verticalWavelengthM, 'gravityWaveSource.verticalWavelengthM');
    if (input.gravityWaveSource.verticalDisplacementM > 0.1 * Math.min(
      input.gravityWaveSource.horizontalWavelengthM,
      input.gravityWaveSource.verticalWavelengthM,
    )) {
      throw new RangeError('gravity-wave displacement must stay below 10% of both wavelengths');
    }
    requireFinite(input.gravityWaveSource.propagationAzimuthRad, 'gravityWaveSource.propagationAzimuthRad');
    if (input.gravityWaveSource.propagationAzimuthRad < 0
      || input.gravityWaveSource.propagationAzimuthRad >= 2 * Math.PI) {
      throw new RangeError('gravity-wave propagation azimuth must be in [0, 2π)');
    }
  }
}

function interpolate(values: readonly CloudEnvironmentLevelInput[], heightM: number): CloudEnvironmentLevelInput {
  if (heightM < values[0]!.heightM || heightM > values[values.length - 1]!.heightM) {
    throw new RangeError('requested diagnostic height is outside the environmental profile');
  }
  for (let index = 1; index < values.length; index += 1) {
    const upper = values[index]!;
    if (upper.heightM >= heightM) {
      const lower = values[index - 1]!;
      const ratio = (heightM - lower.heightM) / (upper.heightM - lower.heightM);
      return {
        heightM,
        pressurePa: lower.pressurePa + (upper.pressurePa - lower.pressurePa) * ratio,
        temperatureK: lower.temperatureK + (upper.temperatureK - lower.temperatureK) * ratio,
        waterVaporSpecificHumidityKgPerKg: lower.waterVaporSpecificHumidityKgPerKg
          + (upper.waterVaporSpecificHumidityKgPerKg - lower.waterVaporSpecificHumidityKgPerKg) * ratio,
        liquidWaterMixingRatioKgPerKg: lower.liquidWaterMixingRatioKgPerKg
          + (upper.liquidWaterMixingRatioKgPerKg - lower.liquidWaterMixingRatioKgPerKg) * ratio,
        iceMixingRatioKgPerKg: lower.iceMixingRatioKgPerKg
          + (upper.iceMixingRatioKgPerKg - lower.iceMixingRatioKgPerKg) * ratio,
        eastWindMps: lower.eastWindMps + (upper.eastWindMps - lower.eastWindMps) * ratio,
        northWindMps: lower.northWindMps + (upper.northWindMps - lower.northWindMps) * ratio,
        largeScaleVerticalVelocityMps: lower.largeScaleVerticalVelocityMps
          + (upper.largeScaleVerticalVelocityMps - lower.largeScaleVerticalVelocityMps) * ratio,
      };
    }
  }
  return values[values.length - 1]!;
}

function deriveColumnWaterVaporKgPerM2(levels: readonly CloudEnvironmentLevelInput[]): number {
  let totalKgPerM2 = 0;
  for (let index = 1; index < levels.length; index += 1) {
    const lower = levels[index - 1]!;
    const upper = levels[index]!;
    const lowerDensity = waterVaporDensityKgPerM3(lower);
    const upperDensity = waterVaporDensityKgPerM3(upper);
    totalKgPerM2 += (lowerDensity + upperDensity) * 0.5 * (upper.heightM - lower.heightM);
  }
  return totalKgPerM2;
}

function deriveUpperIceMoistureFactor(input: CloudEnvironmentInput): number {
  const humidityAt = (level: CloudEnvironmentLevelInput): number => {
    // 飽和の参照は層の相に従う — 氷の式は凝固点までしか当てられないので、暖かい
    // 層は液水飽和と比べる。
    const saturation = level.temperatureK <= 273.15
      ? saturationSpecificHumidityOverIceKgPerKg(level.temperatureK, level.pressurePa)
      : saturationSpecificHumidityOverLiquidKgPerKg(level.temperatureK, level.pressurePa);
    return Math.max(0, Math.min(1, level.waterVaporSpecificHumidityKgPerKg / saturation));
  };
  const samples = [
    interpolate(input.levels, input.upperIceLayerBottomM),
    ...input.levels.filter((level) => (
      level.heightM > input.upperIceLayerBottomM && level.heightM < input.upperIceLayerTopM
    )),
    interpolate(input.levels, input.upperIceLayerTopM),
  ];
  let integratedRelativeHumidityM = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const lower = samples[index - 1]!;
    const upper = samples[index]!;
    integratedRelativeHumidityM += (humidityAt(lower) + humidityAt(upper)) * 0.5
      * (upper.heightM - lower.heightM);
  }
  return integratedRelativeHumidityM / (input.upperIceLayerTopM - input.upperIceLayerBottomM);
}

function deriveBoundaryLayer(levels: readonly CloudEnvironmentLevelInput[]): CloudEnvironmentProfile['boundaryLayer'] {
  const lowest = levels[0]!;
  let strongestGradient = 0;
  let strongestBaseM: number | null = null;
  let strongestTopM: number | null = null;
  let strongestIncreaseK = 0;
  for (let index = 1; index < levels.length; index += 1) {
    const lower = levels[index - 1]!;
    const upper = levels[index]!;
    if (lower.heightM >= MAX_BOUNDARY_LAYER_SEARCH_HEIGHT_M) break;
    const increaseK = virtualPotentialTemperatureK(upper) - virtualPotentialTemperatureK(lower);
    const gradient = increaseK / (upper.heightM - lower.heightM);
    if (increaseK > 0 && gradient > strongestGradient) {
      strongestGradient = gradient;
      strongestBaseM = lower.heightM;
      strongestTopM = upper.heightM;
      strongestIncreaseK = increaseK;
    }
  }
  return {
    depthM: strongestBaseM ?? lowest.heightM,
    inversionBaseM: strongestBaseM,
    inversionTopM: strongestTopM,
    potentialTemperatureIncreaseK: strongestIncreaseK,
  };
}

function deriveLayerStability(levels: readonly CloudEnvironmentLevelInput[]): CloudEnvironmentProfile['layerStability'] {
  return levels.slice(1).map((upper, index) => {
    const lower = levels[index]!;
    const meanVirtualPotentialTemperatureK = (virtualPotentialTemperatureK(lower)
      + virtualPotentialTemperatureK(upper)) / 2;
    const buoyancyFrequencySquaredPerS2 = (GRAVITY_M_PER_S2 / meanVirtualPotentialTemperatureK)
      * (virtualPotentialTemperatureK(upper) - virtualPotentialTemperatureK(lower))
      / (upper.heightM - lower.heightM);
    return Object.freeze({
      lowerHeightM: lower.heightM,
      upperHeightM: upper.heightM,
      buoyancyFrequencySquaredPerS2,
    });
  });
}

function deriveGravityWaveDriver(
  levels: readonly CloudEnvironmentLevelInput[],
  source: GravityWaveSourceInput | null,
  layerStability: CloudEnvironmentProfile['layerStability'],
): CloudEnvironmentProfile['gravityWaveDriver'] {
  if (source === null) {
    return Object.freeze({
      active: false,
      cloudCondensationPossible: false,
      sourceHeightM: null,
      verticalDisplacementM: 0,
      liftedAirTemperatureK: null,
      liftedAirPressurePa: null,
      buoyancyFrequencySquaredPerS2: 0,
      restoringAccelerationMagnitudeMPerS2: 0,
      intrinsicAngularFrequencyRadPerS: 0,
      horizontalPhaseSpeedMps: 0,
      verticalPhaseSpeedMps: 0,
      eastwardPhaseSpeedMps: 0,
      northwardPhaseSpeedMps: 0,
    });
  }
  const layer = layerStability.find((candidate) => (
    source.sourceHeightM >= candidate.lowerHeightM && source.sourceHeightM <= candidate.upperHeightM
  ));
  if (layer === undefined) throw new RangeError('gravity-wave source must lie inside the environmental profile');
  const nSquared = layer.buoyancyFrequencySquaredPerS2;
  const active = nSquared > 0 && source.verticalDisplacementM > 0;
  const sourceEnvironment = interpolate(levels, source.sourceHeightM);
  const liftedTemperatureK = sourceEnvironment.temperatureK
    - DRY_ADIABATIC_LAPSE_RATE_K_PER_M * source.verticalDisplacementM;
  const liftedPressurePa = sourceEnvironment.pressurePa * (
    liftedTemperatureK / sourceEnvironment.temperatureK
  ) ** (DRY_AIR_SPECIFIC_HEAT_J_PER_KG_K / DRY_AIR_GAS_CONSTANT_J_PER_KG_K);
  // 飽和の判定は持ち上げた気塊の相に従う — 氷の式は凝固点までしか当てられない
  // ので、暖かい気塊は液水飽和と比べる。
  const liftedSaturationKgPerKg = liftedTemperatureK <= 273.15
    ? saturationSpecificHumidityOverIceKgPerKg(liftedTemperatureK, liftedPressurePa)
    : saturationSpecificHumidityOverLiquidKgPerKg(liftedTemperatureK, liftedPressurePa);
  const cloudCondensationPossible = active
    && sourceEnvironment.waterVaporSpecificHumidityKgPerKg >= liftedSaturationKgPerKg;
  const horizontalWavenumberPerM = 2 * Math.PI / source.horizontalWavelengthM;
  const verticalWavenumberPerM = 2 * Math.PI / source.verticalWavelengthM;
  const wavenumberMagnitudePerM = Math.hypot(horizontalWavenumberPerM, verticalWavenumberPerM);
  const angularFrequencyRadPerS = active
    ? Math.sqrt(nSquared) * horizontalWavenumberPerM / wavenumberMagnitudePerM
    : 0;
  const horizontalPhaseSpeedMps = active ? angularFrequencyRadPerS / horizontalWavenumberPerM : 0;
  const verticalPhaseSpeedMps = active ? angularFrequencyRadPerS / verticalWavenumberPerM : 0;
  return Object.freeze({
    active,
    cloudCondensationPossible,
    sourceHeightM: source.sourceHeightM,
    verticalDisplacementM: source.verticalDisplacementM,
    liftedAirTemperatureK: liftedTemperatureK,
    liftedAirPressurePa: liftedPressurePa,
    buoyancyFrequencySquaredPerS2: nSquared,
    restoringAccelerationMagnitudeMPerS2: active ? nSquared * source.verticalDisplacementM : 0,
    intrinsicAngularFrequencyRadPerS: angularFrequencyRadPerS,
    horizontalPhaseSpeedMps: horizontalPhaseSpeedMps,
    verticalPhaseSpeedMps: verticalPhaseSpeedMps,
    eastwardPhaseSpeedMps: horizontalPhaseSpeedMps * Math.cos(source.propagationAzimuthRad),
    northwardPhaseSpeedMps: horizontalPhaseSpeedMps * Math.sin(source.propagationAzimuthRad),
  });
}

// 与えられた環境層から frozen な診断プロファイルを組む。入力の場は境界条件で、
// フラックスと雲頂冷却はここでは解かない。パーセル計算は physics 層の
// プロファイル積分で、活動度の代理値ではない。
export function createCloudEnvironmentProfile(input: CloudEnvironmentInput): CloudEnvironmentProfile {
  validateInput(input);
  const levels = Object.freeze(input.levels.map((level) => Object.freeze({ ...level })));
  const layerStability = Object.freeze(deriveLayerStability(levels));
  const parcelLevels: CloudProfileLevel[] = levels.map((level) => ({ ...level }));
  const parcelResult = parcelBuoyancyProfile(parcelLevels);
  const parcel = Object.freeze({
    ...parcelResult,
    profile: Object.freeze(parcelResult.profile.map((level) => Object.freeze({ ...level }))),
  });
  return Object.freeze({
    levels,
    layerStability,
    columnWaterVaporKgPerM2: deriveColumnWaterVaporKgPerM2(levels),
    boundaryLayer: Object.freeze(deriveBoundaryLayer(levels)),
    parcel,
    upperIceMoistureFactor: deriveUpperIceMoistureFactor(input),
    surfaceSensibleHeatFluxWPerM2: input.surfaceSensibleHeatFluxWPerM2,
    surfaceLatentHeatFluxWPerM2: input.surfaceLatentHeatFluxWPerM2,
    cloudTopLongwaveCoolingKPerS: input.cloudTopLongwaveCoolingKPerS,
    gravityWaveDriver: deriveGravityWaveDriver(levels, input.gravityWaveSource, layerStability),
  });
}
