// SI-unit thermodynamics and bulk optical closures for a one-dimensional air parcel.
// Liquid saturation uses WMO-No. 8 (2021), Annex 4.B; ice saturation uses Murphy & Koop
// (2005), valid here from 110 K to 273.16 K. Between -40 and 0 °C, a smoothstep liquid
// fraction blends the two pressures; this is a mixed-phase saturation closure, not a
// prediction of cloud condensate partition. Its temperature derivative defines an
// effective latent heat for pseudoadiabatic ascent (condensate immediately removed).
// The LCL temperature is Bolton (1980), eq. 15. This is a diagnostic parcel model,
// not a cloud-resolving microphysics scheme or a global circulation model.
// Sources: https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/
// instruments-and-methods-of-observation-programme-imop/guide-instruments-and-methods-
// of-observation-wmo-no-8 ; https://doi.org/10.1175/1520-0493(1980)108<1046:TCOEPT>2.0.CO;2
// https://doi.org/10.1256/qj.04.94 ; mixed-phase weighted vapor pressure follows the
// parameterization class discussed by Fu et al. (2004), with smoothstep weights here:
// https://doi.org/10.1175/1520-0469(2004)061<2083:TMCWVP>2.0.CO;2
// CAPE/CIN definitions follow NOAA/NWS glossary terminology:
// https://forecast.weather.gov/glossary.php?word=cap

import type {
  CloudProfileLevel,
  LiftedParcelLevel,
  ParcelBuoyancyDiagnostic,
} from './cloud-thermodynamics-types';

export type {
  CloudAirState,
  CloudProfileLevel,
  LiftedParcelLevel,
  ParcelBuoyancyDiagnostic,
} from './cloud-thermodynamics-types';
export {
  iceEffectiveRadiusM,
  iceOpticalDepth,
  liquidEffectiveRadiusM,
  liquidOpticalDepth,
} from './cloud-optical-closures';

const EPSILON = 0.622; // molecular-mass ratio Mv/Md
const GAS_CONSTANT_DRY_AIR_J_PER_KG_K = 287.05;
const SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K = 1004;
const GRAVITY_M_PER_S2 = 9.80665;
const GAS_CONSTANT_VAPOR_J_PER_KG_K = GAS_CONSTANT_DRY_AIR_J_PER_KG_K / EPSILON;
const MAX_PARCEL_STEP_M = 100;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

// Water/ice saturation pressure over a pure, flat phase surface [Pa].
export function saturationVaporPressureOverLiquidPa(temperatureK: number): number {
  requireFinite(temperatureK, 'temperatureK');
  const temperatureC = temperatureK - 273.15;
  if (temperatureC < -45 || temperatureC > 60) {
    throw new RangeError('liquid-water saturation fit applies from -45 °C to 60 °C');
  }
  return 611.2 * Math.exp((17.62 * temperatureC) / (243.12 + temperatureC));
}

export function saturationVaporPressureOverIcePa(temperatureK: number): number {
  requireFinite(temperatureK, 'temperatureK');
  if (temperatureK < 110 || temperatureK > 273.16) {
    throw new RangeError('Murphy-Koop ice saturation equation applies from 110 K to 273.16 K');
  }
  return Math.exp(
    9.550426 - 5723.265 / temperatureK + 3.53068 * Math.log(temperatureK) - 0.00728332 * temperatureK,
  );
}

// Mixed-phase saturation pressure blends liquid and ice equilibrium pressures from
// -40 °C to 0 °C. Smoothstep weights make both pressure and d(es)/dT continuous at
// the all-ice and all-liquid joins; the interpolation is an explicit bulk closure.
export function saturationVaporPressureOverMixedPhasePa(temperatureK: number): number {
  return mixedPhaseSaturationPressureAndDerivative(temperatureK).vaporPressurePa;
}

function liquidSaturationPressureAndDerivative(temperatureK: number): {
  readonly vaporPressurePa: number;
  readonly derivativePaPerK: number;
} {
  const vaporPressurePa = saturationVaporPressureOverLiquidPa(temperatureK);
  const temperatureC = temperatureK - 273.15;
  return {
    vaporPressurePa,
    derivativePaPerK: vaporPressurePa * 17.62 * 243.12 / (243.12 + temperatureC) ** 2,
  };
}

function iceSaturationPressureAndDerivative(temperatureK: number): {
  readonly vaporPressurePa: number;
  readonly derivativePaPerK: number;
} {
  const vaporPressurePa = saturationVaporPressureOverIcePa(temperatureK);
  const logDerivativePerK = 5723.265 / temperatureK ** 2 + 3.53068 / temperatureK - 0.00728332;
  return { vaporPressurePa, derivativePaPerK: vaporPressurePa * logDerivativePerK };
}

function mixedPhaseSaturationPressureAndDerivative(temperatureK: number): {
  readonly vaporPressurePa: number;
  readonly derivativePaPerK: number;
} {
  requireFinite(temperatureK, 'temperatureK');
  const freezingK = 273.15;
  const allIceK = 233.15;
  if (temperatureK < allIceK || temperatureK > freezingK) {
    throw new RangeError('mixed-phase saturation closure applies from -40 °C to 0 °C');
  }
  const liquid = liquidSaturationPressureAndDerivative(temperatureK);
  const ice = iceSaturationPressureAndDerivative(temperatureK);
  const liquidFractionCoordinate = (temperatureK - allIceK) / (freezingK - allIceK);
  const liquidFraction = liquidFractionCoordinate ** 2 * (3 - 2 * liquidFractionCoordinate);
  const liquidFractionDerivativePerK = 6 * liquidFractionCoordinate
    * (1 - liquidFractionCoordinate) / (freezingK - allIceK);
  return {
    vaporPressurePa: liquidFraction * liquid.vaporPressurePa
      + (1 - liquidFraction) * ice.vaporPressurePa,
    derivativePaPerK: liquidFraction * liquid.derivativePaPerK
      + (1 - liquidFraction) * ice.derivativePaPerK
      + liquidFractionDerivativePerK * (liquid.vaporPressurePa - ice.vaporPressurePa),
  };
}

// Specific humidity q = εe / (p - (1-ε)e), where ε = Mv/Md.
export function saturationSpecificHumidityOverLiquidKgPerKg(
  temperatureK: number,
  pressurePa: number,
): number {
  return saturationSpecificHumidityKgPerKg(
    saturationVaporPressureOverLiquidPa(temperatureK), pressurePa,
  );
}

export function saturationSpecificHumidityOverIceKgPerKg(
  temperatureK: number,
  pressurePa: number,
): number {
  return saturationSpecificHumidityKgPerKg(
    saturationVaporPressureOverIcePa(temperatureK), pressurePa,
  );
}

export function saturationSpecificHumidityOverMixedPhaseKgPerKg(
  temperatureK: number,
  pressurePa: number,
): number {
  return saturationSpecificHumidityKgPerKg(
    saturationVaporPressureOverMixedPhasePa(temperatureK), pressurePa,
  );
}

function saturationSpecificHumidityKgPerKg(vaporPressurePa: number, pressurePa: number): number {
  requirePositive(pressurePa, 'pressurePa');
  if (vaporPressurePa >= pressurePa) {
    throw new RangeError('saturation vapor pressure must be below total pressure');
  }
  return (EPSILON * vaporPressurePa)
    / (pressurePa - (1 - EPSILON) * vaporPressurePa);
}

// Vapor specific humidity is kg/kg moist gas; liquid/ice ratios are kg/kg dry air.
// Convert vapor to dry-air mixing ratio so condensate loading uses one mass basis.
export function virtualTemperatureK(
  temperatureK: number,
  waterVaporSpecificHumidityKgPerKg: number,
  liquidWaterMixingRatioKgPerKg: number,
  iceMixingRatioKgPerKg: number,
): number {
  requirePositive(temperatureK, 'temperatureK');
  requireNonNegative(waterVaporSpecificHumidityKgPerKg, 'waterVaporSpecificHumidityKgPerKg');
  if (waterVaporSpecificHumidityKgPerKg >= 1) {
    throw new RangeError('waterVaporSpecificHumidityKgPerKg must be less than one');
  }
  requireNonNegative(liquidWaterMixingRatioKgPerKg, 'liquidWaterMixingRatioKgPerKg');
  requireNonNegative(iceMixingRatioKgPerKg, 'iceMixingRatioKgPerKg');
  const vaporMixingRatioKgPerKgDryAir = waterVaporSpecificHumidityKgPerKg
    / (1 - waterVaporSpecificHumidityKgPerKg);
  const condensateMixingRatioKgPerKgDryAir = liquidWaterMixingRatioKgPerKg + iceMixingRatioKgPerKg;
  return temperatureK * (1 + vaporMixingRatioKgPerKgDryAir / EPSILON)
    / (1 + vaporMixingRatioKgPerKgDryAir + condensateMixingRatioKgPerKgDryAir);
}

export function parcelBuoyancyMPerS2(
  parcelVirtualTemperatureK: number,
  environmentVirtualTemperatureK: number,
): number {
  requirePositive(parcelVirtualTemperatureK, 'parcelVirtualTemperatureK');
  requirePositive(environmentVirtualTemperatureK, 'environmentVirtualTemperatureK');
  return GRAVITY_M_PER_S2
    * (parcelVirtualTemperatureK - environmentVirtualTemperatureK)
    / environmentVirtualTemperatureK;
}

// Bolton (1980) eq. 15. Returns dry-adiabatic LCL temperature and pressure. The
// height assumes constant dry-adiabatic lapse rate and hydrostatic balance over the
// surface-to-LCL segment; use only for unsaturated boundary-layer parcels.
export function liftingCondensationLevel(
  temperatureK: number,
  pressurePa: number,
  dewPointK: number,
  gravityMPerS2 = GRAVITY_M_PER_S2,
): { readonly temperatureK: number; readonly pressurePa: number; readonly heightM: number } {
  requirePositive(temperatureK, 'temperatureK');
  requirePositive(pressurePa, 'pressurePa');
  requirePositive(dewPointK, 'dewPointK');
  requirePositive(gravityMPerS2, 'gravityMPerS2');
  if (dewPointK > temperatureK) throw new RangeError('dewPointK must not exceed temperatureK');
  const lclTemperatureK = 1
    / (1 / (dewPointK - 56) + Math.log(temperatureK / dewPointK) / 800)
    + 56;
  const lclPressurePa = pressurePa * (lclTemperatureK / temperatureK)
    ** (SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K / GAS_CONSTANT_DRY_AIR_J_PER_KG_K);
  const lapseRateKPerM = gravityMPerS2 / SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K;
  return {
    temperatureK: lclTemperatureK,
    pressurePa: lclPressurePa,
    heightM: (temperatureK - lclTemperatureK) / lapseRateKPerM,
  };
}

function parcelSaturationPressureAndDerivative(temperatureK: number): {
  readonly vaporPressurePa: number;
  readonly derivativePaPerK: number;
} {
  if (temperatureK > 273.15) return liquidSaturationPressureAndDerivative(temperatureK);
  if (temperatureK >= 233.15) return mixedPhaseSaturationPressureAndDerivative(temperatureK);
  return iceSaturationPressureAndDerivative(temperatureK);
}

function parcelSaturationSpecificHumidityKgPerKg(temperatureK: number, pressurePa: number): number {
  return saturationSpecificHumidityKgPerKg(
    parcelSaturationPressureAndDerivative(temperatureK).vaporPressurePa,
    pressurePa,
  );
}

function parcelVirtualTemperatureK(temperatureK: number, pressurePa: number): number {
  return virtualTemperatureK(
    temperatureK,
    parcelSaturationSpecificHumidityKgPerKg(temperatureK, pressurePa),
    0,
    0,
  );
}

function moistAdiabaticLapseRateKPerM(temperatureK: number, pressurePa: number): number {
  const { vaporPressurePa, derivativePaPerK } = parcelSaturationPressureAndDerivative(temperatureK);
  if (vaporPressurePa >= pressurePa) {
    throw new RangeError('parcel saturation pressure must be below total pressure');
  }
  const mixingRatioKgPerKg = EPSILON * vaporPressurePa / (pressurePa - vaporPressurePa);
  const effectiveLatentHeatJPerKg = GAS_CONSTANT_VAPOR_J_PER_KG_K
    * temperatureK ** 2 * derivativePaPerK / vaporPressurePa;
  const latentRatio = effectiveLatentHeatJPerKg * mixingRatioKgPerKg
    / (GAS_CONSTANT_DRY_AIR_J_PER_KG_K * temperatureK);
  const numerator = GRAVITY_M_PER_S2 * (1 + latentRatio);
  const denominator = SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K
    + (effectiveLatentHeatJPerKg ** 2 * mixingRatioKgPerKg * EPSILON)
      / (GAS_CONSTANT_DRY_AIR_J_PER_KG_K * temperatureK ** 2);
  return numerator / denominator;
}

function integrateParcelTemperatureK(
  temperatureK: number,
  pressurePa: number,
  depthM: number,
  saturated: boolean,
): number {
  if (!saturated || depthM === 0) {
    return temperatureK - GRAVITY_M_PER_S2 * depthM / SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K;
  }
  const steps = Math.max(1, Math.ceil(depthM / MAX_PARCEL_STEP_M));
  const stepM = depthM / steps;
  let parcelTemperatureK = temperatureK;
  let parcelPressurePa = pressurePa;
  for (let step = 0; step < steps; step += 1) {
    const lapseAtStart = moistAdiabaticLapseRateKPerM(parcelTemperatureK, parcelPressurePa);
    const midpointTemperatureK = parcelTemperatureK - lapseAtStart * stepM / 2;
    let midpointPressurePa = parcelPressurePa * Math.exp(
      -GRAVITY_M_PER_S2 * stepM
        / (2 * GAS_CONSTANT_DRY_AIR_J_PER_KG_K * parcelVirtualTemperatureK(
          parcelTemperatureK,
          parcelPressurePa,
        )),
    );
    for (let iteration = 0; iteration < 2; iteration += 1) {
      midpointPressurePa = parcelPressurePa * Math.exp(
        -GRAVITY_M_PER_S2 * stepM
          / (2 * GAS_CONSTANT_DRY_AIR_J_PER_KG_K * parcelVirtualTemperatureK(
            midpointTemperatureK,
            midpointPressurePa,
          )),
      );
    }
    const midpointLapse = moistAdiabaticLapseRateKPerM(midpointTemperatureK, midpointPressurePa);
    parcelTemperatureK -= midpointLapse * stepM;
    parcelPressurePa *= Math.exp(
      -GRAVITY_M_PER_S2 * stepM
        / (GAS_CONSTANT_DRY_AIR_J_PER_KG_K * parcelVirtualTemperatureK(
          midpointTemperatureK,
          midpointPressurePa,
        )),
    );
  }
  return parcelTemperatureK;
}

function interpolateProfilePressurePa(
  lower: CloudProfileLevel,
  upper: CloudProfileLevel,
  heightM: number,
): number {
  const fraction = (heightM - lower.heightM) / (upper.heightM - lower.heightM);
  return Math.exp(Math.log(lower.pressurePa) * (1 - fraction) + Math.log(upper.pressurePa) * fraction);
}

function validateProfile(profile: readonly CloudProfileLevel[]): void {
  if (profile.length < 2) throw new RangeError('profile must contain at least two levels');
  for (let i = 0; i < profile.length; i += 1) {
    const level = profile[i]!;
    requireFinite(level.heightM, `profile[${i}].heightM`);
    requirePositive(level.temperatureK, `profile[${i}].temperatureK`);
    requirePositive(level.pressurePa, `profile[${i}].pressurePa`);
    requireNonNegative(level.waterVaporSpecificHumidityKgPerKg, `profile[${i}].waterVaporSpecificHumidityKgPerKg`);
    requireNonNegative(level.liquidWaterMixingRatioKgPerKg, `profile[${i}].liquidWaterMixingRatioKgPerKg`);
    requireNonNegative(level.iceMixingRatioKgPerKg, `profile[${i}].iceMixingRatioKgPerKg`);
    if (i > 0 && (level.heightM <= profile[i - 1]!.heightM || level.pressurePa >= profile[i - 1]!.pressurePa)) {
      throw new RangeError('profile heights must increase and pressures must decrease');
    }
  }
}

// Integrates parcel buoyancy from the first profile level. CIN is the magnitude of
// negative buoyancy below the first LFC; CAPE integrates positive buoyancy until EL.
// The profile must start below its LCL and extend through the first buoyancy return.
export function parcelBuoyancyProfile(
  profile: readonly CloudProfileLevel[],
): ParcelBuoyancyDiagnostic {
  validateProfile(profile);
  const start = profile[0]!;
  const parcelLcl = start.waterVaporSpecificHumidityKgPerKg === 0
    ? null
    : liftingCondensationLevel(
      start.temperatureK,
      start.pressurePa,
      dewPointFromSpecificHumidityK(start.temperatureK, start.pressurePa, start.waterVaporSpecificHumidityKgPerKg),
    );
  const lclHeightM = parcelLcl === null ? null : start.heightM + parcelLcl.heightM;
  const levels: LiftedParcelLevel[] = [];
  let parcelTemperatureK = start.temperatureK;
  let parcelPressurePa = start.pressurePa;
  let previousHeightM = start.heightM;
  let capeJPerKg = 0;
  let cinJPerKg = 0;
  let lfcHeightM: number | null = null;
  let equilibriumHeightM: number | null = null;
  let previousBuoyancyMPerS2: number | null = null;

  for (const environment of profile) {
    if (environment.heightM > start.heightM) {
      const segmentDepthM = environment.heightM - previousHeightM;
      const lclWithinSegment = lclHeightM !== null
        && lclHeightM > previousHeightM
        && lclHeightM < environment.heightM;
      if (lclWithinSegment) {
        const dryDepthM = lclHeightM - previousHeightM;
        parcelTemperatureK = integrateParcelTemperatureK(parcelTemperatureK, parcelPressurePa, dryDepthM, false);
        parcelPressurePa = interpolateProfilePressurePa(
          { ...start, heightM: previousHeightM, pressurePa: parcelPressurePa },
          environment,
          lclHeightM,
        );
        const saturatedDepthM = environment.heightM - lclHeightM;
        parcelTemperatureK = integrateParcelTemperatureK(parcelTemperatureK, parcelPressurePa, saturatedDepthM, true);
      } else {
        const saturated = lclHeightM !== null && previousHeightM >= lclHeightM;
        parcelTemperatureK = integrateParcelTemperatureK(parcelTemperatureK, parcelPressurePa, segmentDepthM, saturated);
      }
      parcelPressurePa = environment.pressurePa;
    }
    const saturatedHumidity = lclHeightM !== null && environment.heightM >= lclHeightM
      ? parcelSaturationSpecificHumidityKgPerKg(parcelTemperatureK, environment.pressurePa)
      : start.waterVaporSpecificHumidityKgPerKg;
    const parcelTv = virtualTemperatureK(parcelTemperatureK, saturatedHumidity, 0, 0);
    const environmentTv = virtualTemperatureK(
      environment.temperatureK,
      environment.waterVaporSpecificHumidityKgPerKg,
      environment.liquidWaterMixingRatioKgPerKg,
      environment.iceMixingRatioKgPerKg,
    );
    const buoyancy = parcelBuoyancyMPerS2(parcelTv, environmentTv);
    if (previousBuoyancyMPerS2 === null && buoyancy > 0) {
      lfcHeightM = environment.heightM;
    }
    levels.push({
      heightM: environment.heightM,
      temperatureK: parcelTemperatureK,
      waterVaporSpecificHumidityKgPerKg: saturatedHumidity,
      buoyancyMPerS2: buoyancy,
    });
    if (previousBuoyancyMPerS2 !== null) {
      const previousLevel = levels[levels.length - 2]!;
      const depthM = environment.heightM - previousLevel.heightM;
      if (lfcHeightM === null && previousBuoyancyMPerS2 <= 0 && buoyancy > 0) {
        lfcHeightM = crossingHeightM(previousLevel.heightM, environment.heightM, previousBuoyancyMPerS2, buoyancy);
        cinJPerKg += integrateNegativeBuoyancyMagnitudeM2PerS2(
          previousBuoyancyMPerS2,
          buoyancy,
          depthM,
        );
      }
      if (lfcHeightM === null) {
        cinJPerKg += integrateNegativeBuoyancyMagnitudeM2PerS2(
          previousBuoyancyMPerS2,
          buoyancy,
          depthM,
        );
      } else if (equilibriumHeightM === null) {
        capeJPerKg += integratePositiveBuoyancyM2PerS2(
          previousBuoyancyMPerS2,
          buoyancy,
          depthM,
        );
        if (previousBuoyancyMPerS2 > 0 && buoyancy <= 0) {
          equilibriumHeightM = crossingHeightM(previousLevel.heightM, environment.heightM, previousBuoyancyMPerS2, buoyancy);
        }
      }
    }
    previousBuoyancyMPerS2 = buoyancy;
    previousHeightM = environment.heightM;
  }
  return { profile: levels, lclHeightM, lfcHeightM, equilibriumHeightM, capeJPerKg, cinJPerKg };
}

function crossingHeightM(
  lowerHeightM: number,
  upperHeightM: number,
  lowerBuoyancyMPerS2: number,
  upperBuoyancyMPerS2: number,
): number {
  const fraction = -lowerBuoyancyMPerS2 / (upperBuoyancyMPerS2 - lowerBuoyancyMPerS2);
  return lowerHeightM + (upperHeightM - lowerHeightM) * fraction;
}

function integratePositiveBuoyancyM2PerS2(
  lowerBuoyancyMPerS2: number,
  upperBuoyancyMPerS2: number,
  depthM: number,
): number {
  if (lowerBuoyancyMPerS2 >= 0 && upperBuoyancyMPerS2 >= 0) {
    return (lowerBuoyancyMPerS2 + upperBuoyancyMPerS2) * depthM / 2;
  }
  if (lowerBuoyancyMPerS2 <= 0 && upperBuoyancyMPerS2 <= 0) return 0;
  const crossingFraction = -lowerBuoyancyMPerS2
    / (upperBuoyancyMPerS2 - lowerBuoyancyMPerS2);
  return lowerBuoyancyMPerS2 > 0
    ? lowerBuoyancyMPerS2 * crossingFraction * depthM / 2
    : upperBuoyancyMPerS2 * (1 - crossingFraction) * depthM / 2;
}

function integrateNegativeBuoyancyMagnitudeM2PerS2(
  lowerBuoyancyMPerS2: number,
  upperBuoyancyMPerS2: number,
  depthM: number,
): number {
  return integratePositiveBuoyancyM2PerS2(
    -lowerBuoyancyMPerS2,
    -upperBuoyancyMPerS2,
    depthM,
  );
}

function dewPointFromSpecificHumidityK(
  temperatureK: number,
  pressurePa: number,
  specificHumidityKgPerKg: number,
): number {
  requireNonNegative(specificHumidityKgPerKg, 'specificHumidityKgPerKg');
  const vaporPressurePa = specificHumidityKgPerKg * pressurePa
    / (EPSILON + (1 - EPSILON) * specificHumidityKgPerKg);
  if (vaporPressurePa <= 0) throw new RangeError('parcel humidity must be positive to diagnose a dew point');
  if (vaporPressurePa > saturationVaporPressureOverLiquidPa(temperatureK)) {
    throw new RangeError('parcel specific humidity must not be supersaturated over liquid water');
  }
  if (vaporPressurePa < saturationVaporPressureOverLiquidPa(273.15 - 45)) {
    throw new RangeError('parcel dew point is below the WMO liquid-water saturation fit range');
  }
  const logVaporPressureRatio = Math.log(vaporPressurePa / 611.2);
  return 273.15 + 243.12 * logVaporPressureRatio / (17.62 - logVaporPressureRatio);
}
