// Deterministic CPU diagnostics for the cloud-lab fixtures. These evaluate declared
// controls and physical response checks; no result is applied to the generated image.
import {
  iceEffectiveRadiusM,
  iceOpticalDepth,
  parcelBuoyancyProfile,
  type CloudProfileLevel,
} from '../../src/physics/cloud-thermodynamics';
import {
  createCloudEnvironmentProfile,
  type CloudEnvironmentInput,
  type CloudEnvironmentLevelInput,
} from '../../src/game/cloud/cloud-environment';
import {
  sampleConvectiveCloudEvents,
  type CloudEventDomain,
  type ConvectiveCloudCell,
  type ConvectiveCloudEvent,
} from '../../src/game/cloud/cloud-events';
import { reconstructCloudParcel } from '../../src/render/cloud/weather-transport';
import { cross, dot, len, norm, v3 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/math/vec3';
import type { MeteorologicalCaseId } from './meteorological-cases';

const EARTH_RADIUS_M = 6_371_000;
const DRY_AIR_GAS_CONSTANT_J_PER_KG_K = 287.05;
const ICE_DENSITY_KG_PER_M3 = 917;
const ICE_NUMBER_CONCENTRATION_PER_M3 = 1e5;
const ICE_EXTINCTION_EFFICIENCY = 2;
const SAMPLE_DURATION_SECONDS = 3_600;
const SAMPLE_MAX_STEP_SECONDS = 30;

export type FixtureComparison = 'absolute-error' | 'greater-than' | 'less-than' | 'non-negative';

export interface FixtureMeasurementResult {
  readonly measurementId: string;
  readonly value: number | null;
  readonly unit: string;
  readonly reference: number | null;
  readonly tolerance: number | null;
  readonly comparison: FixtureComparison | null;
  readonly status: 'pass' | 'fail' | 'blocked';
  readonly detail: string;
}

export interface MeteorologicalCaseEvaluation {
  readonly fixture: MeteorologicalCaseId;
  readonly cpuDiagnosticsApplied: true;
  readonly generatedCloudImageFixtureApplied: false;
  readonly controls: Readonly<Record<string, number | string | boolean>>;
  readonly measurements: readonly FixtureMeasurementResult[];
}

interface EnvironmentControls {
  readonly inversionK?: number;
  readonly upperHumidityScale?: number;
  readonly lapseRateKPerKm?: number;
  readonly splitWinds?: boolean;
  readonly eastWindMps?: number;
  readonly maximumHeightM?: number;
}

function environmentInput(controls: EnvironmentControls = {}): CloudEnvironmentInput {
  const levels: CloudEnvironmentLevelInput[] = [];
  const topLevelIndex = Math.round((controls.maximumHeightM ?? 12_000) / 250);
  for (let index = 0; index <= topLevelIndex; index += 1) {
    const heightM = index * 250;
    const inversionFraction = Math.max(0, Math.min(1, (heightM - 1_000) / 250));
    const upperHumidityScale = controls.upperHumidityScale ?? 1;
    levels.push({
      heightM,
      pressurePa: 100_000 * Math.exp(-heightM / 8_400),
      temperatureK: 289 - (controls.lapseRateKPerKm ?? 6.5) * heightM / 1_000
        + (controls.inversionK ?? 0) * inversionFraction,
      waterVaporSpecificHumidityKgPerKg: 0.009 * Math.exp(-heightM / 2_200)
        * (heightM >= 4_000 ? upperHumidityScale : 1),
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: controls.splitWinds ? (heightM < 2_000 ? 10 : 0) : (controls.eastWindMps ?? 8),
      northWindMps: controls.splitWinds && heightM >= 2_000 ? 10 : 0,
      largeScaleVerticalVelocityMps: 0,
    });
  }
  return {
    levels,
    surfaceSensibleHeatFluxWPerM2: 80,
    surfaceLatentHeatFluxWPerM2: 120,
    cloudTopLongwaveCoolingKPerS: 1e-4,
    gravityWaveSource: {
      sourceHeightM: 5_500,
      verticalDisplacementM: 500,
      horizontalWavelengthM: 10_000,
      verticalWavelengthM: 5_000,
      propagationAzimuthRad: Math.PI / 2,
    },
    upperIceLayerBottomM: 5_500,
    upperIceLayerTopM: 6_000,
  };
}

function cell(upperRelativeHumidity: number, overrides: Partial<ConvectiveCloudCell> = {}): ConvectiveCloudCell {
  return {
    id: 'controlled-cell',
    supplySourceId: 'controlled-water-source',
    convectivePotential: 1,
    upperRelativeHumidity,
    liquidSupplyRateKgM2S: 1e-5,
    convectiveDurationSeconds: 3_600,
    ...overrides,
  };
}

function eventDomain(
  timeSeconds: number,
  cells: readonly ConvectiveCloudCell[],
): CloudEventDomain {
  return {
    seed: 7,
    birthIntervalSeconds: 86_400,
    historyHorizonSeconds: 86_400,
    maximumOmittedMassKgM2: 1,
    maxEventCount: 32,
    timeSeconds,
    cells,
  };
}

function onlyEvent(domain: CloudEventDomain): ConvectiveCloudEvent {
  const event = sampleConvectiveCloudEvents(domain).events[0];
  if (event === undefined) throw new Error('controlled event was not generated');
  return event;
}

function compare(
  measurementId: string,
  value: number,
  unit: string,
  reference: number,
  tolerance: number,
  comparison: FixtureComparison,
  detail: string,
): FixtureMeasurementResult {
  let pass: boolean;
  switch (comparison) {
    case 'absolute-error':
      pass = Math.abs(value - reference) <= tolerance;
      break;
    case 'greater-than':
      pass = value > reference + tolerance;
      break;
    case 'less-than':
      pass = value < reference - tolerance;
      break;
    case 'non-negative':
      pass = value >= reference - tolerance;
      break;
  }
  return {
    measurementId,
    value,
    unit,
    reference,
    tolerance,
    comparison,
    status: pass ? 'pass' : 'fail',
    detail,
  };
}

function blocked(measurementId: string, unit: string, detail: string): FixtureMeasurementResult {
  return {
    measurementId,
    value: null,
    unit,
    reference: null,
    tolerance: null,
    comparison: null,
    status: 'blocked',
    detail,
  };
}

function distanceErrorM(actual: Vec3, expected: Vec3, radiusM: number): number {
  const sine = len(cross(actual, expected));
  const cosine = Math.max(-1, Math.min(1, dot(actual, expected)));
  return Math.atan2(sine, cosine) * radiusM;
}

function localWindAt(levels: readonly CloudEnvironmentLevelInput[]) {
  return (direction: Vec3, heightM: number) => {
    let lower = levels[0]!;
    let upper = levels[levels.length - 1]!;
    for (let index = 1; index < levels.length; index += 1) {
      if (levels[index]!.heightM >= heightM) {
        lower = levels[index - 1]!;
        upper = levels[index]!;
        break;
      }
    }
    const blend = upper.heightM === lower.heightM ? 0
      : Math.max(0, Math.min(1, (heightM - lower.heightM) / (upper.heightM - lower.heightM)));
    const eastMps = lower.eastWindMps + (upper.eastWindMps - lower.eastWindMps) * blend;
    const northMps = lower.northWindMps + (upper.northWindMps - lower.northWindMps) * blend;
    const horizontalRadius = Math.hypot(direction.x, direction.z);
    const eastUnit = horizontalRadius > 1e-12
      ? v3(direction.z / horizontalRadius, 0, -direction.x / horizontalRadius)
      : v3(1, 0, 0);
    const northUnit = norm(v3(
      -direction.x * direction.y,
      horizontalRadius * horizontalRadius,
      -direction.z * direction.y,
    ));
    return {
      tangentVelocityMPerS: v3(
        eastUnit.x * eastMps + northUnit.x * northMps,
        eastUnit.y * eastMps + northUnit.y * northMps,
        eastUnit.z * eastMps + northUnit.z * northMps,
      ),
      verticalVelocityMPerS: lower.largeScaleVerticalVelocityMps
        + (upper.largeScaleVerticalVelocityMps - lower.largeScaleVerticalVelocityMps) * blend,
    };
  };
}

function transportDisplacementM(levels: readonly CloudEnvironmentLevelInput[], heightM: number): Vec3 {
  const start = v3(0, 0, 1);
  const result = reconstructCloudParcel(
    start,
    heightM,
    EARTH_RADIUS_M,
    0,
    SAMPLE_DURATION_SECONDS,
    SAMPLE_MAX_STEP_SECONDS,
    localWindAt(levels),
  );
  return result.directionUnitVector;
}

function maximumPositiveBuoyancyHeightM(input: CloudEnvironmentInput): number {
  const levels: CloudProfileLevel[] = input.levels.map((level) => ({ ...level }));
  const parcel = parcelBuoyancyProfile(levels);
  let maximumHeightM = levels[0]!.heightM;
  for (const level of parcel.profile) {
    if (level.buoyancyMPerS2 > 0) maximumHeightM = level.heightM;
  }
  return maximumHeightM;
}

function residualIceAtHumidity(upperRelativeHumidity: number, timeSeconds: number): number {
  return onlyEvent(eventDomain(timeSeconds, [cell(upperRelativeHumidity)])).iceRelease.remainingKgM2;
}

function evaluateC1(): MeteorologicalCaseEvaluation {
  const speedMps = 10;
  const heightM = 1_000;
  const radiusM = EARTH_RADIUS_M + heightM;
  const displacement = transportDisplacementM(environmentInput({ eastWindMps: speedMps }).levels, heightM);
  const angleRad = speedMps * SAMPLE_DURATION_SECONDS / radiusM;
  const expected = v3(Math.sin(angleRad), 0, Math.cos(angleRad));
  return {
    fixture: 'C1',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: { equatorialEastWindMps: speedMps, durationSeconds: SAMPLE_DURATION_SECONDS, sphereRadiusM: EARTH_RADIUS_M },
    measurements: [
      compare('trajectory', distanceErrorM(displacement, expected, radiusM), 'm', 0, 0.01,
        'absolute-error', 'Great-circle displacement is compared with the analytic equatorial solution.'),
      blocked('mass', '1', 'The parcel transport API returns position only and has no carried-mass state.'),
    ],
  };
}

function evaluateC2(): MeteorologicalCaseEvaluation {
  const env = environmentInput({ splitWinds: true });
  const lowerWindMps = env.levels[0]!.eastWindMps;
  const upperWindMps = env.levels[40]!.northWindMps;
  const lowerHeightM = 1_000;
  const upperHeightM = 10_000;
  const lowerRadiusM = EARTH_RADIUS_M + lowerHeightM;
  const upperRadiusM = EARTH_RADIUS_M + upperHeightM;
  const lower = transportDisplacementM(env.levels, lowerHeightM);
  const upper = transportDisplacementM(env.levels, upperHeightM);
  const lowerAngle = lowerWindMps * SAMPLE_DURATION_SECONDS / lowerRadiusM;
  const upperAngle = upperWindMps * SAMPLE_DURATION_SECONDS / upperRadiusM;
  const expectedLower = v3(Math.sin(lowerAngle), 0, Math.cos(lowerAngle));
  const expectedUpper = v3(0, Math.sin(upperAngle), Math.cos(upperAngle));
  const errorM = Math.max(
    distanceErrorM(lower, expectedLower, lowerRadiusM),
    distanceErrorM(upper, expectedUpper, upperRadiusM),
  );
  return {
    fixture: 'C2',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: { lowerEastWindMps: lowerWindMps, upperNorthWindMps: upperWindMps, durationSeconds: SAMPLE_DURATION_SECONDS },
    measurements: [
      compare('layer-displacement', errorM, 'm', 0, 0.05, 'absolute-error',
        'Lower eastward and upper northward tracks are each compared with analytic great-circle motion.'),
      blocked('released-ice-track', 'deg', 'CloudIceRelease has mass but no birth position or transport track.'),
    ],
  };
}

function evaluateC3(): MeteorologicalCaseEvaluation {
  const event = onlyEvent(eventDomain(3_600, [cell(1)]));
  return {
    fixture: 'C3',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: { supplyDurationSeconds: 3_600, evaluationTimeSeconds: 3_600, upperRelativeHumidity: 1 },
    measurements: [
      compare('anvil-residual', event.iceRelease.remainingKgM2, 'kg m^-2', 0, 0, 'greater-than',
        'The event closure retains released ice at the instant its source supply stops.'),
      blocked('anvil-lifetime', 'min', 'This closure is not calibrated to an independent observed lifetime distribution.'),
    ],
  };
}

function evaluateC4(): MeteorologicalCaseEvaluation {
  const moistEnvironment = createCloudEnvironmentProfile(environmentInput({ upperHumidityScale: 1.3, maximumHeightM: 6_000 }));
  const dryEnvironment = createCloudEnvironmentProfile(environmentInput({ upperHumidityScale: 0.25, maximumHeightM: 6_000 }));
  const moistIce = residualIceAtHumidity(moistEnvironment.upperIceMoistureFactor, 21_600);
  const dryIce = residualIceAtHumidity(dryEnvironment.upperIceMoistureFactor, 21_600);
  const wetMass = onlyEvent(eventDomain(21_600, [cell(moistEnvironment.upperIceMoistureFactor)])).mass;
  const dryMass = onlyEvent(eventDomain(21_600, [cell(dryEnvironment.upperIceMoistureFactor)])).mass;
  return {
    fixture: 'C4',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      moistUpperHumidityScale: 1.3,
      dryUpperHumidityScale: 0.25,
      moistIceHumidityFactor: moistEnvironment.upperIceMoistureFactor,
      dryIceHumidityFactor: dryEnvironment.upperIceMoistureFactor,
      comparisonTimeSeconds: 21_600,
    },
    measurements: [
      compare('sublimation-loss', dryMass.lostKgM2 - wetMass.lostKgM2, 'kg m^-2', 0, 0, 'greater-than',
        'The dry environment drives greater loss in the event model; this is a model response, not an observed rate.'),
      blocked('residual-lifetime', 'min', 'Lifetime threshold crossing is not calibrated or evaluated by the environment diagnostic.'),
      compare('residual-ice-difference', dryIce - moistIce, 'kg m^-2', 0, 0, 'less-than',
        'The same event supply retains less ice under the drier upper-layer input.'),
    ],
  };
}

function evaluateC5(): MeteorologicalCaseEvaluation {
  const weakInput = environmentInput({ inversionK: 0.5, maximumHeightM: 6_000 });
  const strongInput = environmentInput({ inversionK: 8, maximumHeightM: 6_000 });
  const weakTopM = maximumPositiveBuoyancyHeightM(weakInput);
  const strongTopM = maximumPositiveBuoyancyHeightM(strongInput);
  return {
    fixture: 'C5',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: { weakInversionIncreaseK: 0.5, strongInversionIncreaseK: 8, surfaceFluxesHeldFixed: true },
    measurements: [
      compare('convective-top', strongTopM - weakTopM, 'm', 0, 0, 'less-than',
        'The parcel profile integral determines positive-buoyancy extent; it is not an image-derived cloud top.'),
      blocked('deep-penetration', '1', 'Connected cloud geometry and overshooting-top events are not part of the parcel diagnostic.'),
    ],
  };
}

function evaluateC6(): MeteorologicalCaseEvaluation {
  const event = onlyEvent(eventDomain(7_200, [cell(0.7)]));
  const mass = event.mass;
  const doubledSupplyEvent = onlyEvent(eventDomain(7_200, [cell(0.7, { liquidSupplyRateKgM2S: 2e-5 })]));
  const massAtBaseSupplyKgM2 = mass.liquidKgM2 + mass.iceKgM2;
  const massAtDoubledSupplyKgM2 = doubledSupplyEvent.mass.liquidKgM2 + doubledSupplyEvent.mass.iceKgM2;
  const supplyResponseRatio = massAtDoubledSupplyKgM2 / massAtBaseSupplyKgM2;
  const suppliedKgM2 = mass.initialKgM2 + mass.suppliedKgM2;
  const closureResidual = Math.abs(suppliedKgM2 - mass.lostKgM2 - mass.liquidKgM2 - mass.iceKgM2)
    / Math.max(suppliedKgM2, 1e-12);
  const minimumPhaseMassKgM2 = Math.min(mass.initialKgM2, mass.suppliedKgM2, mass.lostKgM2, mass.liquidKgM2, mass.iceKgM2);
  const env = environmentInput();
  const iceLevel = env.levels[40]!;
  const vaporMixingRatio = iceLevel.waterVaporSpecificHumidityKgPerKg
    / (1 - iceLevel.waterVaporSpecificHumidityKgPerKg);
  const dryAirDensityKgPerM3 = iceLevel.pressurePa / (
    DRY_AIR_GAS_CONSTANT_J_PER_KG_K
      * iceLevel.temperatureK
      * (1 + vaporMixingRatio / 0.622)
  );
  const cloudLayerDepthM = 1_000;
  const iceMixingRatioKgPerKg = mass.iceKgM2 / (dryAirDensityKgPerM3 * cloudLayerDepthM);
  const radiusM = iceEffectiveRadiusM(
    dryAirDensityKgPerM3,
    iceMixingRatioKgPerKg,
    ICE_NUMBER_CONCENTRATION_PER_M3,
  );
  const doubledNumberRadiusM = iceEffectiveRadiusM(
    dryAirDensityKgPerM3,
    iceMixingRatioKgPerKg,
    2 * ICE_NUMBER_CONCENTRATION_PER_M3,
  );
  const particleSizeResponseRatio = radiusM === null || doubledNumberRadiusM === null
    ? null
    : doubledNumberRadiusM / radiusM;
  const apiOpticalDepth = radiusM === null ? null
    : iceOpticalDepth(mass.iceKgM2, radiusM, ICE_EXTINCTION_EFFICIENCY);
  const analyticOpticalDepth = radiusM === null ? null
    : 3 * ICE_EXTINCTION_EFFICIENCY * mass.iceKgM2 / (4 * ICE_DENSITY_KG_PER_M3 * radiusM);
  const opticalResidual = apiOpticalDepth === null || analyticOpticalDepth === null
    ? 0
    : Math.abs(apiOpticalDepth - analyticOpticalDepth) / Math.max(analyticOpticalDepth, 1e-12);
  return {
    fixture: 'C6',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      supplyRateKgM2S: 1e-5,
      doubledSupplyRateKgM2S: 2e-5,
      supplyDurationSeconds: 3_600,
      evaluationTimeSeconds: 7_200,
      iceNumberConcentrationPerM3: ICE_NUMBER_CONCENTRATION_PER_M3,
      doubledIceNumberConcentrationPerM3: 2 * ICE_NUMBER_CONCENTRATION_PER_M3,
      iceExtinctionEfficiency: ICE_EXTINCTION_EFFICIENCY,
    },
    measurements: [
      compare('supply-response', supplyResponseRatio, '1', 2, 1e-12, 'absolute-error',
        'Doubling only the declared liquid supply rate doubles the event column mass.'),
      particleSizeResponseRatio === null
        ? blocked('particle-size-response', '1', 'Nonzero ice is required to compare number-concentration controls.')
        : compare('particle-size-response', particleSizeResponseRatio, '1', 2 ** (-1 / 3), 1e-12,
          'absolute-error', 'Doubling only particle number changes spherical-equivalent radius by N^(-1/3).'),
      compare('mass-balance', closureResidual, '1', 0, 1e-12, 'absolute-error',
        'Checks the event ledger identity against the mass-conservation equation.'),
      compare('non-negative', minimumPhaseMassKgM2, 'kg m^-2', 0, 0, 'non-negative',
        'Minimum of initial, supplied, lost, liquid, and ice column masses.'),
      radiusM === null || apiOpticalDepth === null || analyticOpticalDepth === null
        ? blocked('optical-closure', '1', 'The controlled event must have nonzero ice before radius and optical depth are evaluated.')
        : compare('optical-closure', opticalResidual, '1', 0, 1e-12, 'absolute-error',
          'Radius derives from dry-air density and ice mixing ratio; optical depth is checked against the geometric-optics equation.'),
    ],
  };
}

function evaluateC7(): MeteorologicalCaseEvaluation {
  const moistInput = environmentInput({ upperHumidityScale: 1.3, splitWinds: true });
  const dryInput = environmentInput({ upperHumidityScale: 0.1, splitWinds: true });
  const moist = createCloudEnvironmentProfile({ ...moistInput, levels: moistInput.levels.slice(0, 25) });
  const dry = createCloudEnvironmentProfile({ ...dryInput, levels: dryInput.levels.slice(0, 25) });
  const wave = moist.gravityWaveDriver;
  const waveTravelM = wave.northwardPhaseSpeedMps * SAMPLE_DURATION_SECONDS;
  const kh = 2 * Math.PI / 10_000;
  const m = 2 * Math.PI / 5_000;
  const expectedOmega = Math.sqrt(wave.buoyancyFrequencySquaredPerS2) * kh / Math.hypot(kh, m);
  const expectedWaveTravelM = expectedOmega / kh * SAMPLE_DURATION_SECONDS;
  const materialTrack = reconstructCloudParcel(
    v3(0, 0, 1),
    10_000,
    EARTH_RADIUS_M,
    0,
    SAMPLE_DURATION_SECONDS,
    SAMPLE_MAX_STEP_SECONDS,
    localWindAt(moistInput.levels),
  );
  const expectedMaterialTravelM = moistInput.levels[40]!.northWindMps * SAMPLE_DURATION_SECONDS;
  const materialTravelM = Math.acos(Math.max(-1, Math.min(1, materialTrack.directionUnitVector.z)))
    * (EARTH_RADIUS_M + 10_000);
  return {
    fixture: 'C7',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      gravityWaveSourceHeightM: 5_500,
      horizontalWavelengthM: 10_000,
      verticalWavelengthM: 5_000,
      propagationAzimuthRad: Math.PI / 2,
      moistIceHumidityFactor: moist.upperIceMoistureFactor,
      dryIceHumidityFactor: dry.upperIceMoistureFactor,
      upperNorthWindMps: moistInput.levels[40]!.northWindMps,
    },
    measurements: [
      compare('wave-track', waveTravelM, 'm', expectedWaveTravelM, 1e-8, 'absolute-error',
        'Intrinsic phase travel follows the linear Boussinesq dispersion relation.'),
      compare('material-track', materialTravelM, 'm', expectedMaterialTravelM, 0.05, 'absolute-error',
        'The air-mass track integrates the supplied northward upper-level wind on the sphere.'),
      compare('wave-cloud-condensation', Number(moist.gravityWaveDriver.cloudCondensationPossible), '1', 1, 0,
        'absolute-error', 'A moist saturated control condenses under the prescribed lift.'),
      compare('dry-wave-cloud-control', Number(dry.gravityWaveDriver.cloudCondensationPossible), '1', 0, 0,
        'absolute-error', 'The dry control retains the same source and stability but does not reach ice saturation.'),
      blocked('directional-spectrum', '1', 'No gridded cloud-density field is available for spectral analysis.'),
    ],
  };
}

function blockedCase(id: 'C8' | 'C9'): MeteorologicalCaseEvaluation {
  const blockedMeasurements = id === 'C8'
    ? [
      blocked('hole-fraction', '1', 'Marine boundary-layer cell geometry is not implemented.'),
      blocked('cell-size', 'km', 'Marine boundary-layer cell geometry is not implemented.'),
      blocked('cell-lifetime', 'min', 'Marine boundary-layer event lifecycle is not implemented.'),
    ]
    : [
      blocked('layer-gap', 'm', 'A multi-layer cloud density field is not implemented.'),
      blocked('parallax', 'px', 'Projected multi-layer geometry is not implemented.'),
      blocked('shadow-support', 'm2', 'Shared multi-layer density and shadow support are not implemented.'),
    ];
  return {
    fixture: id,
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {},
    measurements: blockedMeasurements,
  };
}

export function evaluateMeteorologicalCase(id: MeteorologicalCaseId): MeteorologicalCaseEvaluation {
  switch (id) {
    case 'C1': return evaluateC1();
    case 'C2': return evaluateC2();
    case 'C3': return evaluateC3();
    case 'C4': return evaluateC4();
    case 'C5': return evaluateC5();
    case 'C6': return evaluateC6();
    case 'C7': return evaluateC7();
    case 'C8':
    case 'C9': return blockedCase(id);
  }
}
