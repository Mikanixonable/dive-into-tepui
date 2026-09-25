// Environment-driven cloud morphology diagnostics used by controlled cases and the
// rendering closure. These are deterministic engineering closures, not a cloud-resolving model.

export interface MarineBoundaryLayerInput {
  readonly oceanFraction: number;
  readonly relativeHumidity: number;
  readonly subsidenceMps: number;
  readonly cloudTopCoolingKPerS: number;
  readonly inversionStrengthK: number;
  readonly convectiveActivity: number;
}

export interface MarineCellDiagnostics {
  readonly organization: number;
  readonly openCellFraction: number;
  readonly closedCellFraction: number;
  readonly holeFraction: number;
  readonly cellDiameterKm: number;
  readonly lifetimeMinutes: number;
}

export interface WaveCloudInput {
  readonly humidityFactor: number;
  readonly verticalDisplacementM: number;
  readonly horizontalWavelengthM: number;
  readonly phaseSpeedMps: number;
}

export interface WaveCloudDiagnostics {
  readonly condensationFraction: number;
  readonly directionalPower: number;
  readonly wavelengthKm: number;
  readonly phaseTravelMPerHour: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth01 = (value: number): number => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function requireUnit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}

export function marineBoundaryLayerDiagnostics(input: MarineBoundaryLayerInput): MarineCellDiagnostics {
  requireUnit(input.oceanFraction, 'oceanFraction');
  requireUnit(input.relativeHumidity, 'relativeHumidity');
  requireUnit(input.convectiveActivity, 'convectiveActivity');
  for (const [name, value] of Object.entries({
    subsidenceMps: input.subsidenceMps,
    cloudTopCoolingKPerS: input.cloudTopCoolingKPerS,
    inversionStrengthK: input.inversionStrengthK,
  })) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  }
  const moist = smooth01((input.relativeHumidity - 0.55) / 0.35);
  const cooling = smooth01(input.cloudTopCoolingKPerS / 2e-4);
  const inversion = smooth01(input.inversionStrengthK / 8);
  const subsidence = smooth01(Math.max(input.subsidenceMps, 0) / 0.03);
  const quiet = 1 - input.convectiveActivity;
  const organization = clamp01(input.oceanFraction * moist * (0.3 + 0.7 * cooling)
    * (0.35 + 0.65 * inversion) * (0.4 + 0.6 * subsidence));
  // Closed cells dominate a moist, strongly inverted, weakly precipitating/convective deck.
  const closedCellFraction = clamp01(organization * (0.55 + 0.45 * quiet));
  const openCellFraction = clamp01(organization * (0.25 + 0.75 * input.convectiveActivity));
  const total = Math.max(openCellFraction + closedCellFraction, 1e-9);
  const openShare = openCellFraction / total;
  const holeFraction = clamp01(0.08 + organization * (0.12 + 0.52 * openShare));
  // 20–80 km cells, controlled by boundary-layer organization rather than latitude.
  const cellDiameterKm = 20 + 60 * organization * (0.65 + 0.35 * openShare);
  const lifetimeMinutes = 30 + 240 * organization * (0.7 + 0.3 * inversion);
  return Object.freeze({
    organization,
    openCellFraction,
    closedCellFraction,
    holeFraction,
    cellDiameterKm,
    lifetimeMinutes,
  });
}

export function waveCloudDiagnostics(input: WaveCloudInput): WaveCloudDiagnostics {
  if (!Number.isFinite(input.humidityFactor) || input.humidityFactor < 0) {
    throw new RangeError('humidityFactor must be finite and non-negative');
  }
  if (!(input.verticalDisplacementM >= 0) || !Number.isFinite(input.verticalDisplacementM)) {
    throw new RangeError('verticalDisplacementM must be finite and non-negative');
  }
  if (!(input.horizontalWavelengthM > 0) || !Number.isFinite(input.horizontalWavelengthM)) {
    throw new RangeError('horizontalWavelengthM must be finite and positive');
  }
  if (!Number.isFinite(input.phaseSpeedMps)) throw new RangeError('phaseSpeedMps must be finite');
  const lift = smooth01(input.verticalDisplacementM / 1_000);
  const humidity = smooth01((input.humidityFactor - 0.7) / 0.3);
  const condensationFraction = clamp01(lift * humidity);
  return Object.freeze({
    condensationFraction,
    // Power is directional because one prescribed wave vector owns the coherent component.
    directionalPower: condensationFraction * condensationFraction,
    wavelengthKm: input.horizontalWavelengthM / 1_000,
    phaseTravelMPerHour: Math.abs(input.phaseSpeedMps) * 3_600,
  });
}

export function deepConvectivePenetrationFraction(
  positiveBuoyancyTopM: number, inversionTopM: number, tropopauseM: number,
): number {
  if (![positiveBuoyancyTopM, inversionTopM, tropopauseM].every(Number.isFinite)) {
    throw new RangeError('convective penetration heights must be finite');
  }
  if (tropopauseM <= inversionTopM) return 0;
  return clamp01((positiveBuoyancyTopM - inversionTopM) / (tropopauseM - inversionTopM));
}
