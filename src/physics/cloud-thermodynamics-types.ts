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
  readonly lclHeightM: number | null;
  readonly lfcHeightM: number | null;
  readonly equilibriumHeightM: number | null;
  readonly capeJPerKg: number;
  readonly cinJPerKg: number;
}
