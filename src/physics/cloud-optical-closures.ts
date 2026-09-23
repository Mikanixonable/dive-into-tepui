// Bulk radius closures assume spherical-equivalent particles of one representative
// number concentration. They do not predict a particle size distribution. Liquid
// optical depth follows Stephens (1978):
// https://doi.org/10.1175/1520-0469(1978)035<2111:RPIEWC>2.0.CO;2

const WATER_DENSITY_KG_PER_M3 = 1000;
const ICE_DENSITY_KG_PER_M3 = 917;

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

// Liquid geometric-optics closure: tau = 3 LWP/(2 rhoWater re), for visible
// wavelengths and droplets much larger than the wavelength (Qext approximately 2).
export function liquidOpticalDepth(
  liquidWaterPathKgPerM2: number,
  effectiveRadiusM: number,
): number {
  requireNonNegative(liquidWaterPathKgPerM2, 'liquidWaterPathKgPerM2');
  requirePositive(effectiveRadiusM, 'effectiveRadiusM');
  return 3 * liquidWaterPathKgPerM2 / (2 * WATER_DENSITY_KG_PER_M3 * effectiveRadiusM);
}

// Ice exposes extinction efficiency so habit/spectral dependence is explicit.
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
