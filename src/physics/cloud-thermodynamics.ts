// SI-unit thermodynamics and bulk optical closures for a one-dimensional air parcel.
// Saturation pressure follows WMO-No. 8 (2021), Annex 4.B equations 4.B.1/4.B.3;
// those Magnus fits are limited to -45..60 °C over liquid water and -65..0 °C over ice.
// The LCL temperature is Bolton (1980), eq. 15; moist ascent uses the reversible-free
// pseudoadiabatic lapse rate (condensate immediately removed). This is a diagnostic
// parcel model, not a cloud-resolving microphysics scheme or a global circulation model.
// Sources: https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/
// instruments-and-methods-of-observation-programme-imop/guide-instruments-and-methods-
// of-observation-wmo-no-8 ; https://doi.org/10.1175/1520-0493(1980)108<1046:TCOEPT>2.0.CO;2
// Liquid optical depth is the Stephens (1978) geometric-optics closure:
// https://doi.org/10.1175/1520-0469(1978)035<2111:RPIEWC>2.0.CO;2
// CAPE/CIN definitions follow NOAA/NWS glossary terminology:
// https://forecast.weather.gov/glossary.php?word=cap

const EPSILON = 0.622; // molecular-mass ratio Mv/Md
const GAS_CONSTANT_DRY_AIR_J_PER_KG_K = 287.05;
const SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K = 1004;
const GRAVITY_M_PER_S2 = 9.80665;
const LATENT_HEAT_VAPORIZATION_J_PER_KG = 2.5e6;
const WATER_DENSITY_KG_PER_M3 = 1000;
const ICE_DENSITY_KG_PER_M3 = 917;
const MAX_PARCEL_STEP_M = 100;

export interface CloudAirState {
  readonly temperatureK: number;
  readonly pressurePa: number;
  readonly waterVaporSpecificHumidityKgPerKg: number;
  readonly liquidWaterMixingRatioKgPerKg: number;
  readonly iceMixingRatioKgPerKg: number;
}

export interface CloudProfileLevel extends CloudAirState {
  readonly heightM: number;
}

export interface LiftedParcelLevel {
  readonly heightM: number;
  readonly temperatureK: number;
  readonly waterVaporSpecificHumidityKgPerKg: number;
  readonly buoyancyMPerS2: number;
}

export interface ParcelBuoyancyDiagnostic {
  readonly profile: readonly LiftedParcelLevel[];
  readonly lclHeightM: number;
  readonly lfcHeightM: number | null;
  readonly equilibriumHeightM: number | null;
  readonly capeJPerKg: number;
  readonly cinJPerKg: number;
}

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
  const temperatureC = temperatureK - 273.15;
  if (temperatureC < -45 || temperatureC > 60) {
    throw new RangeError('liquid-water saturation fit applies from -45 °C to 60 °C');
  }
  return 611.2 * Math.exp((17.62 * temperatureC) / (243.12 + temperatureC));
}

export function saturationVaporPressureOverIcePa(temperatureK: number): number {
  const temperatureC = temperatureK - 273.15;
  if (temperatureC < -65 || temperatureC > 0) {
    throw new RangeError('ice saturation fit applies from -65 °C to 0 °C');
  }
  return 611.2 * Math.exp((22.46 * temperatureC) / (272.62 + temperatureC));
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

function moistAdiabaticLapseRateKPerM(temperatureK: number, pressurePa: number): number {
  const vaporPressurePa = saturationVaporPressureOverLiquidPa(temperatureK);
  const mixingRatioKgPerKg = EPSILON * vaporPressurePa / (pressurePa - vaporPressurePa);
  const latentRatio = LATENT_HEAT_VAPORIZATION_J_PER_KG * mixingRatioKgPerKg
    / (GAS_CONSTANT_DRY_AIR_J_PER_KG_K * temperatureK);
  const numerator = GRAVITY_M_PER_S2 * (1 + latentRatio);
  const denominator = SPECIFIC_HEAT_DRY_AIR_J_PER_KG_K
    + (LATENT_HEAT_VAPORIZATION_J_PER_KG ** 2 * mixingRatioKgPerKg * EPSILON)
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
    const midpointPressurePa = parcelPressurePa * Math.exp(
      -GRAVITY_M_PER_S2 * stepM
        / (GAS_CONSTANT_DRY_AIR_J_PER_KG_K * midpointTemperatureK),
    );
    const midpointLapse = moistAdiabaticLapseRateKPerM(midpointTemperatureK, midpointPressurePa);
    parcelTemperatureK -= midpointLapse * stepM;
    parcelPressurePa = midpointPressurePa * Math.exp(
      -GRAVITY_M_PER_S2 * stepM
        / (GAS_CONSTANT_DRY_AIR_J_PER_KG_K * parcelTemperatureK),
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
  const parcelLcl = liftingCondensationLevel(
    start.temperatureK,
    start.pressurePa,
    dewPointFromSpecificHumidityK(start.temperatureK, start.pressurePa, start.waterVaporSpecificHumidityKgPerKg),
  );
  const lclHeightM = start.heightM + parcelLcl.heightM;
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
      const lclWithinSegment = lclHeightM > previousHeightM && lclHeightM < environment.heightM;
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
        const saturated = previousHeightM >= lclHeightM;
        parcelTemperatureK = integrateParcelTemperatureK(parcelTemperatureK, parcelPressurePa, segmentDepthM, saturated);
      }
      parcelPressurePa = environment.pressurePa;
    }
    const saturatedHumidity = environment.heightM >= lclHeightM
      ? saturationSpecificHumidityOverLiquidKgPerKg(parcelTemperatureK, environment.pressurePa)
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
  let lowerK = 273.15 - 45;
  let upperK = Math.min(temperatureK, 273.15 + 60);
  if (vaporPressurePa < saturationVaporPressureOverLiquidPa(lowerK)) {
    throw new RangeError('parcel dew point is below the WMO liquid-water saturation fit range');
  }
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const midpointK = (lowerK + upperK) / 2;
    if (saturationVaporPressureOverLiquidPa(midpointK) < vaporPressurePa) lowerK = midpointK;
    else upperK = midpointK;
  }
  return (lowerK + upperK) / 2;
}

// Bulk radius closures assume spherical-equivalent particles of one representative
// number concentration. They do not predict a particle size distribution.
export function liquidEffectiveRadiusM(
  dryAirDensityKgPerM3: number,
  liquidWaterMixingRatioKgPerKg: number,
  dropletNumberConcentrationPerM3: number,
): number | null {
  requireNonNegative(dryAirDensityKgPerM3, 'dryAirDensityKgPerM3');
  requireNonNegative(liquidWaterMixingRatioKgPerKg, 'liquidWaterMixingRatioKgPerKg');
  requirePositive(dropletNumberConcentrationPerM3, 'dropletNumberConcentrationPerM3');
  if (dryAirDensityKgPerM3 === 0 || liquidWaterMixingRatioKgPerKg === 0) return null;
  return (3 * dryAirDensityKgPerM3 * liquidWaterMixingRatioKgPerKg
    / (4 * Math.PI * WATER_DENSITY_KG_PER_M3 * dropletNumberConcentrationPerM3)) ** (1 / 3);
}

export function iceEffectiveRadiusM(
  dryAirDensityKgPerM3: number,
  iceMixingRatioKgPerKg: number,
  iceNumberConcentrationPerM3: number,
): number | null {
  requireNonNegative(dryAirDensityKgPerM3, 'dryAirDensityKgPerM3');
  requireNonNegative(iceMixingRatioKgPerKg, 'iceMixingRatioKgPerKg');
  requirePositive(iceNumberConcentrationPerM3, 'iceNumberConcentrationPerM3');
  if (dryAirDensityKgPerM3 === 0 || iceMixingRatioKgPerKg === 0) return null;
  return (3 * dryAirDensityKgPerM3 * iceMixingRatioKgPerKg
    / (4 * Math.PI * ICE_DENSITY_KG_PER_M3 * iceNumberConcentrationPerM3)) ** (1 / 3);
}

// Liquid geometric-optics closure: τ = 3 LWP/(2 ρw re), for visible wavelengths
// and droplets much larger than the wavelength (extinction efficiency Qext ≈ 2).
export function liquidOpticalDepth(
  liquidWaterPathKgPerM2: number,
  effectiveRadiusM: number,
): number {
  requireNonNegative(liquidWaterPathKgPerM2, 'liquidWaterPathKgPerM2');
  requirePositive(effectiveRadiusM, 'effectiveRadiusM');
  return 3 * liquidWaterPathKgPerM2 / (2 * WATER_DENSITY_KG_PER_M3 * effectiveRadiusM);
}

// Ice uses an explicit extinction efficiency to expose habit/spectral dependence;
// the volume-equivalent sphere relation is not assumed to share liquid water's Qext.
export function iceOpticalDepth(
  iceWaterPathKgPerM2: number,
  effectiveRadiusM: number,
  extinctionEfficiency: number,
): number {
  requireNonNegative(iceWaterPathKgPerM2, 'iceWaterPathKgPerM2');
  requirePositive(effectiveRadiusM, 'effectiveRadiusM');
  requirePositive(extinctionEfficiency, 'extinctionEfficiency');
  return 3 * extinctionEfficiency * iceWaterPathKgPerM2
    / (4 * ICE_DENSITY_KG_PER_M3 * effectiveRadiusM);
}
