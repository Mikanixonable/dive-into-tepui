// 雲ラボの制御入力に対し、決定論的な CPU 物理診断と判定値を返す。
import * as THREE from 'three/webgpu';
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
import {
  reconstructCloudEventMaterialCohorts,
  reconstructCloudEventMaterialTracks,
} from '../../src/game/cloud/cloud-event-transport';
import { reconstructCloudParcel } from '../../src/render/cloud/weather-transport';
import { integrateCloudLocalOpticalPath } from '../../src/game/cloud/cloud-local-optical-path';
import {
  cloudLocalUvAt,
  integrateCloudLocalFieldRayCpu,
} from '../../src/render/cloud/cloud-local-field';
import { cross, dot, norm, scale, v3 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/math/vec3';
import { metersPerPixelAtDepth } from '../../src/math/projection';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import { OrthographicCap } from '../../src/render/field-projection';
import { CLOUD_CAP_SIZE, capRadiusFor } from '../../src/render/cloud/cloud-cap';
import { CLOUD_TOP_SPAN } from '../../src/render/cloud/cumulus-shape';
import {
  analyticC2ReleasedIceDirection,
  C2_CONTINUOUS_ORACLE_INTERVALS,
  evaluateC2ContinuousReleaseOracle,
} from './c2-continuous-release-oracle';
import { massWeightedSphericalRmsSpreadM, sphericalDistanceM as distanceErrorM }
  from './spherical-measures';
import {
  cloudExtinctionLayersFromVolume,
  cloudOpticalVolumeLayerPlane,
  equivalentDiameterM,
  fieldMemberMask,
  fieldValueCentroid,
  interiorHoleShare,
  labelFieldComponents,
  measureComponentPersistence,
  unionShiftedSupportAreaM2,
} from './meteorological-field-measures';
import { directionalPowerSpectrum } from './meteorological-field-spectrum';
import {
  buildC9TwoDiscField,
  buildCellFieldPlane,
  buildCellFieldSeries,
  buildWaveFieldPlane,
  C8_CELL_FIELD_CELL_COUNT,
  C8_CELL_FIELD_CELL_SIZE_M,
  C8_CELL_FIELD_EXTINCTION_PER_M,
  C8_CELL_FIELD_PERIOD_M,
  C9_CELL_SIZE_M,
  C9_ICE_LAYER_CENTER_M,
  C9_LAYER_EDGES_M,
  C9_LIQUID_LAYER_CENTER_M,
} from './meteorological-fixture-fields';
import { sampleEventOpticalVolume } from '../render-lab/cloud-event-optical-volume-case';
import {
  METEOROLOGICAL_ERROR_FLOORS,
  type MeteorologicalCaseId,
} from './meteorological-cases';
import { earthCenterOf } from '../render-lab/lab-earth';
import { EARTH_CASES } from '../render-lab/earth-cases';
import { FOV_DEG, VIEW_HEIGHT } from '../render-lab/lab-case';

const EARTH_RADIUS_M = 6_371_000;
const DRY_AIR_GAS_CONSTANT_J_PER_KG_K = 287.05;
const ICE_DENSITY_KG_PER_M3 = 917;
const ICE_NUMBER_CONCENTRATION_PER_M3 = 1e5;
const ICE_EXTINCTION_EFFICIENCY = 2;
const SAMPLE_DURATION_SECONDS = 3_600;
const SAMPLE_MAX_STEP_SECONDS = 30;
const C1_EXPECTED_INTEGRATED_MASS_KG = 0.009;
const C1_TWO_KM_FEATURE_WAVELENGTH_M = 2_000;
const C1_MINIMUM_SAMPLES_PER_FEATURE = 4;
const C2_PLAN_MAXIMUM_SPATIAL_SAMPLE_SPACING_M = 500;
// C9 の二円盤 fixture の解析的診断値。fixture の幾何から独立に決まる参照値。
const C9_VERTICAL_LIQUID_TAU = 0.4;
const C9_VERTICAL_ICE_TAU = 0.2;
const C9_VERTICAL_TOTAL_TAU = 0.6;
const C9_SLANT_AZIMUTH_RAD = Math.PI / 4;
const C9_SLANT_TOTAL_TAU = C9_VERTICAL_TOTAL_TAU / Math.cos(C9_SLANT_AZIMUTH_RAD);
const C9_GAP_THICKNESS_M = 3_000;
const C9_GAP_LOWER_M = 3_000;
const C9_GAP_UPPER_M = 6_000;
const C9_TAU_TOLERANCE = 0.005;
// 45° の投影ずれ・風の交差軸偽変位の許容値 [m]。層中央の高さ差 5 km に対応する。
const C9_CENTROID_TOLERANCE_M = 500;
const C9_WIND_DISPLACEMENT_M = 36_000;
const C9_RAY_STEPS = 1_024;
const C9_PROJECTION_AZIMUTH_EAST_M = 1;
const C9_PROJECTION_AZIMUTH_NORTH_M = 0;

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

export interface AreaWeightedMassSample {
  readonly areaWeightM2: number;
  readonly massKgM2: number;
}

export interface AreaWeightedMassBudgetSample {
  readonly areaWeightM2: number;
  readonly initialKgM2: number;
  readonly sourceKgM2: number;
  readonly lossKgM2: number;
  readonly currentKgM2: number;
}

export interface AreaWeightedMassBudget {
  readonly initialKg: number;
  readonly sourceKg: number;
  readonly lossKg: number;
  readonly currentKg: number;
  readonly residualKg: number;
  readonly relativeResidual: number;
}

// 面積重み付き質量を検査し、有限な総質量だけを返す。
export function areaWeightedMassKg(samples: readonly AreaWeightedMassSample[]): number {
  for (const sample of samples) {
    if (!Number.isFinite(sample.areaWeightM2) || sample.areaWeightM2 < 0) {
      throw new RangeError('areaWeightM2 must be finite and non-negative');
    }
    if (!Number.isFinite(sample.massKgM2) || sample.massKgM2 < 0) {
      throw new RangeError('massKgM2 must be finite and non-negative');
    }
  }
  const totalMassKg = samples.reduce((total, sample) => {
    const weightedMassKg = sample.areaWeightM2 * sample.massKgM2;
    const nextTotalMassKg = total + weightedMassKg;
    if (!Number.isFinite(weightedMassKg) || !Number.isFinite(nextTotalMassKg)) {
      throw new RangeError('area-weighted mass total must be finite');
    }
    return nextTotalMassKg;
  }, 0);
  return totalMassKg;
}

// 各列の水収支を面積積分してから総量を比較する。
export function areaWeightedMassBudget(
  samples: readonly AreaWeightedMassBudgetSample[],
): AreaWeightedMassBudget {
  const totals = { initialKg: 0, sourceKg: 0, lossKg: 0, currentKg: 0 };
  for (const sample of samples) {
    if (!Number.isFinite(sample.areaWeightM2) || sample.areaWeightM2 < 0) {
      throw new RangeError('areaWeightM2 must be finite and non-negative');
    }
    totals.initialKg = addWeightedMassKg(
      totals.initialKg, sample.areaWeightM2, sample.initialKgM2, 'initialKgM2',
    );
    totals.sourceKg = addWeightedMassKg(
      totals.sourceKg, sample.areaWeightM2, sample.sourceKgM2, 'sourceKgM2',
    );
    totals.lossKg = addWeightedMassKg(
      totals.lossKg, sample.areaWeightM2, sample.lossKgM2, 'lossKgM2',
    );
    totals.currentKg = addWeightedMassKg(
      totals.currentKg, sample.areaWeightM2, sample.currentKgM2, 'currentKgM2',
    );
  }
  const residualKg = totals.initialKg + totals.sourceKg - totals.lossKg - totals.currentKg;
  if (!Number.isFinite(residualKg)) throw new RangeError('mass budget residual must be finite');
  const referenceMassKg = totals.initialKg + totals.sourceKg;
  return {
    ...totals,
    residualKg,
    relativeResidual: referenceMassKg === 0
      ? (residualKg === 0 ? 0 : Number.POSITIVE_INFINITY)
      : Math.abs(residualKg) / referenceMassKg,
  };
}

function addWeightedMassKg(
  currentTotalKg: number,
  areaWeightM2: number,
  massKgM2: number,
  massName: string,
): number {
  if (!Number.isFinite(massKgM2) || massKgM2 < 0) {
    throw new RangeError(`${massName} must be finite and non-negative`);
  }
  const weightedMassKg = areaWeightM2 * massKgM2;
  const nextTotalKg = currentTotalKg + weightedMassKg;
  if (!Number.isFinite(weightedMassKg) || !Number.isFinite(nextTotalKg)) {
    throw new RangeError('area-weighted mass budget must be finite');
  }
  return nextTotalKg;
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

function rotateAroundAxis(direction: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const cosine = Math.cos(angleRad);
  const sine = Math.sin(angleRad);
  const axialComponent = dot(axis, direction);
  const perpendicularRotation = cross(axis, direction);
  return norm(v3(
    direction.x * cosine + perpendicularRotation.x * sine + axis.x * axialComponent * (1 - cosine),
    direction.y * cosine + perpendicularRotation.y * sine + axis.y * axialComponent * (1 - cosine),
    direction.z * cosine + perpendicularRotation.z * sine + axis.z * axialComponent * (1 - cosine),
  ));
}

function axisRotationPhaseRad(start: Vec3, end: Vec3, axis: Vec3): number {
  const startPerpendicular = v3(
    start.x - axis.x * dot(start, axis),
    start.y - axis.y * dot(start, axis),
    start.z - axis.z * dot(start, axis),
  );
  const endPerpendicular = v3(
    end.x - axis.x * dot(end, axis),
    end.y - axis.y * dot(end, axis),
    end.z - axis.z * dot(end, axis),
  );
  return Math.atan2(dot(axis, cross(startPerpendicular, endPerpendicular)),
    dot(startPerpendicular, endPerpendicular));
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

// 名前付き近距離 shot のカメラ・cap から、生成場と内部ラスタの標本間隔を導く。
function nearRangeCloudSampling(shotName: string): {
  spacingM: number; cameraDistanceM: number; internalRasterScale: number;
} {
  const earthCase = EARTH_CASES.earth();
  const shot = earthCase.shots?.[shotName];
  if (earthCase.earth === undefined || earthCase.viewTarget === undefined
    || shot?.view.cameraDistanceLog === undefined
    || shot.graphics?.resolutionScale === undefined) {
    throw new Error(`near-range cloud shot ${shotName} must define Earth placement and camera distance`);
  }
  const cameraForward = earthCase.camera.getWorldDirection(new THREE.Vector3());
  const pivotDepth = cameraForward.dot(
    new THREE.Vector3().subVectors(earthCase.viewTarget, earthCase.camera.position),
  );
  const pivot = earthCase.camera.position.clone().addScaledVector(cameraForward, pivotDepth);
  const nearDistance = cameraForward.dot(
    new THREE.Vector3().subVectors(pivot, earthCase.camera.position),
  ) * 10 ** shot.view.cameraDistanceLog;
  const nearPlacement = { ...earthCase.earth, ...shot.view };
  const surfacePoint = earthCenterOf(nearPlacement).add(new THREE.Vector3(0, 0, R_EARTH_EQ));
  // 地表を注視する shot の契約が崩れた場合、投影尺度は意味を失う。
  if (surfacePoint.distanceTo(pivot) > 1e-6) {
    throw new Error('standard near-range cloud shot pivot must lie on the equatorial surface');
  }

  const rho = (R_EARTH_EQ + nearDistance) / R_EARTH_EQ;
  const capRadius = capRadiusFor(rho, CLOUD_TOP_SPAN / R_EARTH_EQ);
  const cap = new OrthographicCap(CLOUD_CAP_SIZE, 0, 0, capRadius);
  return {
    spacingM: cap.texelAngleValue * R_EARTH_EQ,
    cameraDistanceM: nearDistance,
    internalRasterScale: shot.graphics.resolutionScale,
  };
}

export interface C1NearRangeRasterDiagnostic {
  readonly diagnosticOnly: true;
  readonly shot: 'cloud-c1-raster-200km-medium-diagnostic';
  readonly cameraDistanceM: number;
  readonly internalRasterSamplesPerTwoKm: number;
  readonly requiredSamplesPerTwoKm: number;
  readonly status: 'candidate-sufficient' | 'insufficient';
}

// 将来の C1 条件選択に使う medium raster の診断値。C1 の正式判定へは適用しない。
export function evaluateC1NearRangeRasterDiagnostic(): C1NearRangeRasterDiagnostic {
  const shot = 'cloud-c1-raster-200km-medium-diagnostic';
  const sampling = nearRangeCloudSampling(shot);
  const screenSamples = C1_TWO_KM_FEATURE_WAVELENGTH_M
    / metersPerPixelAtDepth(FOV_DEG, sampling.cameraDistanceM, VIEW_HEIGHT);
  const internalRasterSamplesPerTwoKm = screenSamples * sampling.internalRasterScale;
  return {
    diagnosticOnly: true,
    shot,
    cameraDistanceM: sampling.cameraDistanceM,
    internalRasterSamplesPerTwoKm,
    requiredSamplesPerTwoKm: C1_MINIMUM_SAMPLES_PER_FEATURE,
    status: internalRasterSamplesPerTwoKm < C1_MINIMUM_SAMPLES_PER_FEATURE
      ? 'insufficient' : 'candidate-sufficient',
  };
}

function residualIceAtHumidity(upperRelativeHumidity: number, timeSeconds: number): number {
  return onlyEvent(eventDomain(timeSeconds, [cell(upperRelativeHumidity)])).iceRelease.remainingKgM2;
}

// 剛体回転する有限雲塊の質量・軌跡を独立式と比べ、描画標本の成立性を添える。
function evaluateC1(): MeteorologicalCaseEvaluation {
  const heightM = 1_000;
  const radiusM = EARTH_RADIUS_M + heightM;
  const durationSeconds = SAMPLE_DURATION_SECONDS;
  const rotationAngleRad = 1e-3;
  const angularVelocityRadPerSecond = rotationAngleRad / durationSeconds;
  const rotationAxisUnitVector = norm(v3(1, 2, -1));
  const maximumTransportStepSeconds = 5;
  const initialLiquidMassKgM2 = 0.00025;
  const initialIceMassKgM2 = 0.00075;
  const fieldSampling = nearRangeCloudSampling('cloud-standard-near-range-250km');
  const twoKmResponseMaximumSpacingM = C1_TWO_KM_FEATURE_WAVELENGTH_M / C1_MINIMUM_SAMPLES_PER_FEATURE;
  const twoKmFeatureScreenSamples = C1_TWO_KM_FEATURE_WAVELENGTH_M
    / metersPerPixelAtDepth(FOV_DEG, fieldSampling.cameraDistanceM, VIEW_HEIGHT);
  const twoKmFeatureInternalRasterSamples = twoKmFeatureScreenSamples * fieldSampling.internalRasterScale;
  const twoKmResponseBlocked = fieldSampling.spacingM > twoKmResponseMaximumSpacingM;
  // 面積の違う材料点を同じ角速度で運び、軌跡と積分質量を別々に測る。
  const blobPoints = [
    { direction: norm(v3(-0.018, -0.009, 1)), areaWeightM2: 1, initialMassKgM2: 0.0006 },
    { direction: norm(v3(-0.009, 0.014, 1)), areaWeightM2: 2, initialMassKgM2: 0.0008 },
    { direction: norm(v3(0.002, -0.016, 1)), areaWeightM2: 3, initialMassKgM2: 0.001 },
    { direction: norm(v3(0.012, 0.011, 1)), areaWeightM2: 2, initialMassKgM2: 0.0012 },
    { direction: norm(v3(0.021, -0.004, 1)), areaWeightM2: 1, initialMassKgM2: 0.0014 },
  ];
  const transportedMassSamples: AreaWeightedMassSample[] = [];
  const transportedBudgetSamples: AreaWeightedMassBudgetSample[] = [];
  let maximumTrajectoryErrorM = 0;
  let maximumRotationAngleErrorRad = 0;
  const windAt = (directionUnitVector: Vec3, geometricHeightM: number) => ({
    tangentVelocityMPerS: scale(
      cross(rotationAxisUnitVector, directionUnitVector),
      angularVelocityRadPerSecond * (EARTH_RADIUS_M + geometricHeightM),
    ),
    verticalVelocityMPerS: 0,
  });

  for (const [index, point] of blobPoints.entries()) {
    const eventId = `c1-rigid-blob-${index}`;
    const event: ConvectiveCloudEvent = {
      id: eventId,
      cellId: eventId,
      birthEpoch: 0,
      birthTimeSeconds: 0,
      ageSeconds: durationSeconds,
      sourcePosition: { directionUnitVector: point.direction, geometricHeightM: heightM },
      supplyActive: false,
      mass: {
        initialKgM2: point.initialMassKgM2,
        suppliedKgM2: 0,
        lostKgM2: 0,
        liquidKgM2: point.initialMassKgM2 * initialLiquidMassKgM2
          / (initialLiquidMassKgM2 + initialIceMassKgM2),
        iceKgM2: point.initialMassKgM2 * initialIceMassKgM2
          / (initialLiquidMassKgM2 + initialIceMassKgM2),
      },
      iceRelease: {
        id: `${eventId}:ice`,
        parentEventId: eventId,
        releasedKgM2: point.initialMassKgM2 * initialIceMassKgM2
          / (initialLiquidMassKgM2 + initialIceMassKgM2),
        remainingKgM2: point.initialMassKgM2 * initialIceMassKgM2
          / (initialLiquidMassKgM2 + initialIceMassKgM2),
        meanReleaseTimeSeconds: durationSeconds / 2,
        releaseRateKgM2S: point.initialMassKgM2 * initialIceMassKgM2
          / ((initialLiquidMassKgM2 + initialIceMassKgM2) * durationSeconds),
        releaseStartTimeSeconds: 0,
        releaseEndTimeSeconds: durationSeconds,
        sublimationRatePerSecond: 0,
        releaseHeightM: heightM,
      },
      lifecycle: {
        liquidSupplyRateKgM2S: 0,
        convectiveDurationSeconds: 0,
        iceYieldFraction: 0.35,
        upperRelativeHumidity: 1,
      },
      generation: 0,
      parentEventId: null,
    };
    const material = reconstructCloudEventMaterialCohorts(
      event,
      EARTH_RADIUS_M,
      maximumTransportStepSeconds,
      windAt,
      1,
    );
    transportedMassSamples.push({
      areaWeightM2: point.areaWeightM2,
      massKgM2: material.totalMassKgM2,
    });
    transportedBudgetSamples.push({
      areaWeightM2: point.areaWeightM2,
      initialKgM2: point.initialMassKgM2,
      sourceKgM2: 0,
      lossKgM2: 0,
      currentKgM2: material.totalMassKgM2,
    });

    const expectedDirection = rotateAroundAxis(point.direction, rotationAxisUnitVector, rotationAngleRad);
    if (material.parent === null) throw new Error('C1 blob point must retain its liquid parent');
    maximumTrajectoryErrorM = Math.max(maximumTrajectoryErrorM,
      distanceErrorM(material.parent.directionUnitVector, expectedDirection, radiusM));
    maximumRotationAngleErrorRad = Math.max(maximumRotationAngleErrorRad,
      Math.abs(axisRotationPhaseRad(point.direction, material.parent.directionUnitVector,
        rotationAxisUnitVector) - rotationAngleRad));
    for (const cohort of material.releasedIceCohorts) {
      maximumTrajectoryErrorM = Math.max(maximumTrajectoryErrorM,
        distanceErrorM(cohort.directionUnitVector, expectedDirection, radiusM));
    }
  }
  const transportedIntegratedMassKg = areaWeightedMassKg(transportedMassSamples);
  const finiteAreaBudget = areaWeightedMassBudget(transportedBudgetSamples);
  const relativeMassError = finiteAreaBudget.relativeResidual;
  return {
    fixture: 'C1',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      rotationAxisUnitVector: `${rotationAxisUnitVector.x.toFixed(6)},${rotationAxisUnitVector.y.toFixed(6)},${rotationAxisUnitVector.z.toFixed(6)}`,
      rotationAngleRad,
      durationSeconds,
      sphereRadiusM: EARTH_RADIUS_M,
      initialLiquidMassKgM2,
      initialIceMassKgM2,
      areaWeightedBlobMassKg: C1_EXPECTED_INTEGRATED_MASS_KG,
      transportedAreaWeightedMassKg: transportedIntegratedMassKg,
      initialFiniteAreaMassKg: finiteAreaBudget.initialKg,
      sourceFiniteAreaMassKg: finiteAreaBudget.sourceKg,
      lossFiniteAreaMassKg: finiteAreaBudget.lossKg,
      currentFiniteAreaMassKg: finiteAreaBudget.currentKg,
      finiteAreaBudgetResidualKg: finiteAreaBudget.residualKg,
      maximumAnalyticTrajectoryErrorM: maximumTrajectoryErrorM,
      standardNearRangeCloudFieldCenterSpacingM: fieldSampling.spacingM,
      twoKmFeatureMaximumFieldSpacingM: twoKmResponseMaximumSpacingM,
      twoKmFeatureSamplesPerFieldWavelength: C1_TWO_KM_FEATURE_WAVELENGTH_M / fieldSampling.spacingM,
      twoKmFeatureScreenSamples,
      twoKmFeatureInternalRasterSamples,
      twoKmInternalRasterResponseStatus: twoKmFeatureInternalRasterSamples < C1_MINIMUM_SAMPLES_PER_FEATURE
        ? 'blocked' : 'raster-resolution-sufficient',
      twoKmCloudFieldResponseStatus: twoKmResponseBlocked ? 'blocked' : 'field-resolution-sufficient',
      materialPointCount: blobPoints.length,
      maximumTransportStepSeconds,
    },
    measurements: [
      blocked('trajectory', 'm',
        `The standard near-range field spacing is ${fieldSampling.spacingM.toFixed(1)} m; the 2 km response requires at most ${twoKmResponseMaximumSpacingM.toFixed(1)} m for four field samples per wavelength, so trajectory/2 km qualification remains blocked.`),
      compare('rotation-angle', maximumRotationAngleErrorRad, 'rad', 0, 1e-9, 'absolute-error',
        'The transported material point phase about the prescribed rotation axis is compared with angular velocity times elapsed time.'),
      compare('mass', relativeMassError, '1', 0, METEOROLOGICAL_ERROR_FLOORS.relativeMass, 'absolute-error',
        'Heterogeneous material columns are area-integrated after advection and compared with an independently fixed quadrature total.'),
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
  const event = onlyEvent(eventDomain(SAMPLE_DURATION_SECONDS, [cell(1, {
    sourcePosition: { directionUnitVector: v3(0, 0, 1), geometricHeightM: lowerHeightM },
    iceReleaseHeightM: upperHeightM,
  })]));
  const releaseTimeSeconds = event.iceRelease.meanReleaseTimeSeconds;
  const releasedIce = reconstructCloudEventMaterialTracks(
    event, EARTH_RADIUS_M, SAMPLE_MAX_STEP_SECONDS, localWindAt(env.levels),
  ).releasedIce;
  if (releaseTimeSeconds === null || releasedIce === null) {
    throw new Error('C2 controlled event must contain released ice and its representative release time');
  }
  const cohortCount = 16;
  const releasedIceCohorts = reconstructCloudEventMaterialCohorts(
    event,
    EARTH_RADIUS_M,
    SAMPLE_MAX_STEP_SECONDS,
    localWindAt(env.levels),
    cohortCount,
  ).releasedIceCohorts;
  if (releasedIceCohorts.length !== cohortCount) {
    throw new Error(`C2 controlled event must retain all ${cohortCount} released-ice cohorts`);
  }
  const expectedReleasedIce = analyticC2ReleasedIceDirection(
    releaseTimeSeconds,
    SAMPLE_DURATION_SECONDS,
    EARTH_RADIUS_M,
    lowerHeightM,
    upperHeightM,
    lowerWindMps,
    upperWindMps,
  );
  const expectedCohorts = releasedIceCohorts.map((cohort) => ({
    directionUnitVector: analyticC2ReleasedIceDirection(
      cohort.meanReleaseTimeSeconds,
      SAMPLE_DURATION_SECONDS,
      EARTH_RADIUS_M,
      lowerHeightM,
      upperHeightM,
      lowerWindMps,
      upperWindMps,
    ),
    massKgM2: cohort.massKgM2,
  }));
  const maximumCohortTrajectoryErrorM = Math.max(...releasedIceCohorts.map((cohort, index) =>
    distanceErrorM(cohort.directionUnitVector, expectedCohorts[index]!.directionUnitVector,
      upperRadiusM)));
  const cohortMassKgM2 = releasedIceCohorts.reduce((total, cohort) => total + cohort.massKgM2, 0);
  const cohortMassErrorKgM2 = Math.abs(cohortMassKgM2 - event.iceRelease.remainingKgM2);
  const actualCohortSpreadM = massWeightedSphericalRmsSpreadM(releasedIceCohorts, upperRadiusM);
  const expectedCohortSpreadM = massWeightedSphericalRmsSpreadM(expectedCohorts, upperRadiusM);
  const cohortSpreadErrorM = Math.abs(actualCohortSpreadM - expectedCohortSpreadM);
  const releaseStartTimeSeconds = event.iceRelease.releaseStartTimeSeconds;
  const releaseEndTimeSeconds = event.iceRelease.releaseEndTimeSeconds;
  if (releaseStartTimeSeconds === null || releaseEndTimeSeconds === null) {
    throw new Error('C2 controlled event must have a continuous ice release interval');
  }
  const convergenceCounts = [4, 16, 64, 256] as const;
  const cohortsByCount = convergenceCounts.map((count) => ({
    count,
    cohorts: reconstructCloudEventMaterialCohorts(
      event, EARTH_RADIUS_M, SAMPLE_MAX_STEP_SECONDS, localWindAt(env.levels), count,
    ).releasedIceCohorts,
  }));
  const continuousOracle = evaluateC2ContinuousReleaseOracle({
    releaseStartTimeSeconds,
    releaseEndTimeSeconds,
    sampleTimeSeconds: SAMPLE_DURATION_SECONDS,
    sphereRadiusM: EARTH_RADIUS_M,
    lowerHeightM,
    upperHeightM,
    lowerEastWindMps: lowerWindMps,
    upperNorthWindMps: upperWindMps,
    releaseRateKgM2S: event.iceRelease.releaseRateKgM2S,
    sublimationRatePerSecond: event.iceRelease.sublimationRatePerSecond,
    cohortsByCount,
  });
  return {
    fixture: 'C2',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      lowerEastWindMps: lowerWindMps,
      upperNorthWindMps: upperWindMps,
      durationSeconds: SAMPLE_DURATION_SECONDS,
      representativeReleaseTimeSeconds: releaseTimeSeconds,
      iceCohortCount: releasedIceCohorts.length,
      eventRemainingIceKgM2: event.iceRelease.remainingKgM2,
      reconstructedIceCohortMassKgM2: cohortMassKgM2,
      actualIceCohortSpreadM: actualCohortSpreadM,
      analyticIceCohortSpreadM: expectedCohortSpreadM,
      continuousReleaseOracleIntervals: C2_CONTINUOUS_ORACLE_INTERVALS,
      continuousReleaseQuadratureErrorM: continuousOracle.quadratureRefinementDeltaM,
      continuousReleasePlanMaximumSpatialSpacingM: C2_PLAN_MAXIMUM_SPATIAL_SAMPLE_SPACING_M,
      continuousReleaseAbsoluteSpatialTolerance: 'blocked: plan specifies a maximum spacing, not a minimum or acceptance tolerance',
      continuousReleaseCentroidQuadratureBoundM: continuousOracle.centroidQuadratureErrorBoundM,
      continuousReleaseCohortCounts: convergenceCounts.join(','),
      continuousReleaseConvergenceErrorsM: continuousOracle.convergenceErrorsM.join(','),
      continuousReleaseOracleSpreadM: continuousOracle.spreadM,
      continuousReleaseOracleMassKgM2: continuousOracle.massKgM2,
    },
    measurements: [
      compare('layer-displacement', errorM, 'm', 0, 0.05, 'absolute-error',
        'Lower eastward and upper northward tracks are each compared with analytic great-circle motion.'),
      compare('released-ice-track', distanceErrorM(
        releasedIce.directionUnitVector, expectedReleasedIce, upperRadiusM,
      ), 'm', 0, 0.05, 'absolute-error',
      'Representative surviving ice cohort follows parent displacement before release and upper wind afterward.'),
      compare('released-ice-cohorts', maximumCohortTrajectoryErrorM, 'm', 0, 0.05,
        'absolute-error',
        'Every surviving ice cohort follows the analytic lower-east path until its own release time, then the upper-north path.'),
      compare('released-ice-mass', cohortMassErrorKgM2, 'kg m^-2', 0, 1e-12,
        'absolute-error',
        'The sum of all reconstructed cohort masses matches the event remaining-ice ledger.'),
      compare('released-ice-spread', cohortSpreadErrorM, 'm', 0, 0.05,
        'absolute-error',
        'Mass-weighted spherical RMS spread is compared with the spread of independently evaluated analytic cohort endpoints.'),
      blocked('continuous-release-distribution', 'm',
        'The fixed 32768-interval midpoint oracle reports raw cohort centroid/spread errors in controls, and its midpoint centroid quadrature has a second-derivative error bound. Absolute plan qualification is blocked: §2.7 specifies at most 0.5 km between spatial samples, not a minimum spacing or a permitted transport error.'),
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
  // 波源入力と同じ水平波長・伝播方位の調和場へ、方向別スペクトルの測定機構を当てる。
  // 波源が湿潤層を変調して作る形態場の生成はまだ無いので、解析的な fixture 場で測る。
  const wavePlane = buildWaveFieldPlane({
    cellCount: 64,
    spanM: 60_000,
    wavelengthM: 10_000,
    propagationAzimuthRad: Math.PI / 2,
    extinctionPerM: 1e-4,
  });
  const waveSpectrum = directionalPowerSpectrum(wavePlane, 18);
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
      waveSpectrumCellCount: wavePlane.width,
      waveSpectrumSpanM: wavePlane.width * wavePlane.cellWidthM,
      waveSpectrumAzimuthBinCount: waveSpectrum.azimuthBinPowers.length,
      waveSpectrumPeakComponentAzimuthRad: waveSpectrum.peakComponentAzimuthRad ?? 'none',
      waveSpectrumPeakBinPowerShare: waveSpectrum.directionalConcentration,
      waveSpectrumAzimuthBinPowers: waveSpectrum.azimuthBinPowers.join(','),
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
      blocked('directional-spectrum', '1',
        'The directional spatial spectrum of the prescribed wave field is measured and reported in controls '
        + `(peak component azimuth ${(waveSpectrum.peakComponentAzimuthRad ?? Number.NaN).toFixed(4)} rad, `
        + `peak-bin share ${waveSpectrum.directionalConcentration.toFixed(4)}), but the plan leaves the `
        + 'quantitative directional-spectrum acceptance band to be fixed before the Step 5 wave-morphology implementation.'),
    ],
  };
}

function evaluateC8(): MeteorologicalCaseEvaluation {
  const cellPlane = buildCellFieldPlane();
  const totalCellCount = cellPlane.width * cellPlane.height;
  const cellAreaM2 = cellPlane.cellWidthM * cellPlane.cellHeightM;
  const cloudy = labelFieldComponents(cellPlane, 0, 'above', true);
  const clear = labelFieldComponents(cellPlane, 0, 'at-or-below', false);
  const holes = interiorHoleShare(clear, totalCellCount);
  const interiorHoleDiametersM = clear.components
    .filter((component) => !component.touchesBoundary)
    .map((component) => equivalentDiameterM(component.cellCount, cellAreaM2));
  const cloudyDiametersM = cloudy.components
    .map((component) => equivalentDiameterM(component.cellCount, cellAreaM2));
  const largestCloudyDiameterM = cloudyDiametersM.length === 0
    ? 0 : Math.max(...cloudyDiametersM);
  const meanHoleDiameterM = interiorHoleDiametersM.length === 0
    ? 0 : interiorHoleDiametersM.reduce((total, diameter) => total + diameter, 0)
      / interiorHoleDiametersM.length;
  // 寿命機構: 30 分で中央の一つの穴が埋まる系列へ、成分の重複追跡を当てる。
  const series = buildCellFieldSeries();
  const clearPersistence = measureComponentPersistence(
    series.map((frame) => ({
      timeMinutes: frame.timeMinutes,
      memberCells: fieldMemberMask(frame.plane, 0, 'at-or-below'),
    })),
    cellPlane.width, cellPlane.height, cellPlane.cellWidthM, cellPlane.cellHeightM,
    cellPlane.originEastM, cellPlane.originNorthM, false,
  );
  const cloudyPersistence = measureComponentPersistence(
    series.map((frame) => ({
      timeMinutes: frame.timeMinutes,
      memberCells: fieldMemberMask(frame.plane, 0, 'above'),
    })),
    cellPlane.width, cellPlane.height, cellPlane.cellWidthM, cellPlane.cellHeightM,
    cellPlane.originEastM, cellPlane.originNorthM, true,
  );
  // 実イベント堆積の供給場にも同じ層抽出・形態計測を当てる診断。
  const supplyVolume = sampleEventOpticalVolume();
  const supplyPlane = cloudOpticalVolumeLayerPlane(
    supplyVolume,
    { originEastM: -8_000, originNorthM: -8_000, cellWidthM: 250, cellHeightM: 250 },
    0, 'liquid',
  );
  const supplyCloudy = labelFieldComponents(supplyPlane, 0, 'above', true);
  const supplyClear = labelFieldComponents(supplyPlane, 0, 'at-or-below', false);
  const supplyHoles = interiorHoleShare(supplyClear, supplyPlane.width * supplyPlane.height);
  return {
    fixture: 'C8',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      cellFieldCellCount: C8_CELL_FIELD_CELL_COUNT,
      cellFieldCellSizeM: C8_CELL_FIELD_CELL_SIZE_M,
      cellFieldPeriodM: C8_CELL_FIELD_PERIOD_M,
      cellFieldExtinctionPerM: C8_CELL_FIELD_EXTINCTION_PER_M,
      cloudyComponentCount: cloudy.components.length,
      interiorHoleComponentCount: holes.interiorComponentCount,
      holeFraction: holes.interiorShare,
      largestCloudyComponentEquivalentDiameterM: largestCloudyDiameterM,
      meanInteriorHoleEquivalentDiameterM: meanHoleDiameterM,
      clearComponentPersistenceDurationsMin: clearPersistence.durationsMinutes.join(','),
      cloudyComponentPersistenceDurationsMin: cloudyPersistence.durationsMinutes.join(','),
      supplyFieldLiquidCloudyComponentCount: supplyCloudy.components.length,
      supplyFieldHoleFraction: supplyHoles.interiorShare,
      supplyFieldInteriorHoleCount: supplyHoles.interiorComponentCount,
    },
    measurements: [
      blocked('hole-fraction', '1',
        `Measured on the cell fixture field (interior share ${holes.interiorShare.toFixed(4)}, `
        + 'declared uncertaintyFloor 1e-3); the quantitative '
        + 'observation-constrained acceptance band is not fixed yet.'),
      blocked('cell-size', 'km',
        `Measured (largest cloudy equivalent diameter ${(largestCloudyDiameterM / 1_000).toFixed(2)} km, `
        + `mean interior-hole diameter ${(meanHoleDiameterM / 1_000).toFixed(2)} km); the quantitative `
        + 'cell-size acceptance band is not fixed yet.'),
      blocked('cell-lifetime', 'min',
        `Persistence tracking on the fixture series reports ${clearPersistence.durationsMinutes.length} `
        + 'clear-component tracks and cloud-component tracks in controls; the quantitative '
        + 'lifetime acceptance band is not fixed yet.'),
    ],
  };
}

// 45° 光路の水平方位へ、層中央の高さだけずらした地表投影位置を返す。方位は +east に固定。
function projectedCentroid(
  centroid: { readonly eastM: number; readonly northM: number },
  layerCenterAltitudeM: number,
): { readonly eastM: number; readonly northM: number } {
  const shiftM = layerCenterAltitudeM * Math.tan(C9_SLANT_AZIMUTH_RAD);
  return {
    eastM: centroid.eastM + shiftM * C9_PROJECTION_AZIMUTH_EAST_M,
    northM: centroid.northM + shiftM * C9_PROJECTION_AZIMUTH_NORTH_M,
  };
}

// 半径の等しい二円盤を中心間隔だけずらして重ねた和集合の面積 [m2]。
function twoDiscUnionAreaM2(radiusM: number, centerOffsetM: number): number {
  const overlap = 2 * radiusM * radiusM * Math.acos(centerOffsetM / (2 * radiusM))
    - centerOffsetM / 2 * Math.sqrt(4 * radiusM * radiusM - centerOffsetM * centerOffsetM);
  return 2 * Math.PI * radiusM * radiusM - overlap;
}

function evaluateC9(): MeteorologicalCaseEvaluation {
  const centered = { eastM: 0, northM: 0 };
  const base = buildC9TwoDiscField(centered, centered);
  const liquidOnly = buildC9TwoDiscField(centered, null);
  const iceOnly = buildC9TwoDiscField(null, centered);
  const frame = base.frame;
  const frameGrid = {
    originEastM: frame.gridOriginEastM,
    originNorthM: frame.gridOriginNorthM,
    cellWidthM: frame.cellWidthM,
    cellHeightM: frame.cellHeightM,
  };

  // 三描画経路と同じ規則の CPU 参照で、鉛直と 45° の中心光路を積分する。
  const surfaceCenterN = v3(0, 0, 1);
  const slantDirection = norm(v3(1, 0, 1));
  const verticalPath = integrateCloudLocalFieldRayCpu(
    surfaceCenterN, v3(0, 0, 1), base.data, frame, C9_RAY_STEPS);
  const slantPath = integrateCloudLocalFieldRayCpu(
    surfaceCenterN, slantDirection, base.data, frame, C9_RAY_STEPS);
  const liquidOnlyPath = integrateCloudLocalFieldRayCpu(
    surfaceCenterN, v3(0, 0, 1), liquidOnly.data, liquidOnly.frame, C9_RAY_STEPS);
  const iceOnlyPath = integrateCloudLocalFieldRayCpu(
    surfaceCenterN, v3(0, 0, 1), iceOnly.data, iceOnly.frame, C9_RAY_STEPS);

  // 独立した参照として、セル内一定消散の厳密な格子横断積分を併記する。
  const strictLayers = cloudExtinctionLayersFromVolume(base.data);
  const strictGrid = { ...frameGrid, width: frame.gridWidth, height: frame.gridHeight };
  const strictVertical = integrateCloudLocalOpticalPath(
    { eastM: 0, northM: 0, altitudeM: 0 },
    { eastM: 0, northM: 0, altitudeM: C9_LAYER_EDGES_M[C9_LAYER_EDGES_M.length - 1]! },
    strictGrid, strictLayers,
  );
  const strictSlant = integrateCloudLocalOpticalPath(
    { eastM: 0, northM: 0, altitudeM: 0 },
    { eastM: 8_000, northM: 0, altitudeM: 8_000 },
    strictGrid, strictLayers,
  );

  // 空隙: 両相の支持層に挟まれた零消散帯の厚さ。空隙への漏れは支持を動かして帯を狭める。
  const layerCount = C9_LAYER_EDGES_M.length - 1;
  const cellCount = base.data.width * base.data.height;
  let liquidSupportTopM = 0;
  let iceSupportBottomM = Number.POSITIVE_INFINITY;
  let hasLiquid = false;
  let hasIce = false;
  for (let layer = 0; layer < layerCount; layer += 1) {
    if (base.data.liquidExtinctionPerM
      .subarray(layer * cellCount, (layer + 1) * cellCount).some((value) => value > 0)) {
      hasLiquid = true;
      liquidSupportTopM = Math.max(liquidSupportTopM, C9_LAYER_EDGES_M[layer + 1]!);
    }
    if (base.data.iceExtinctionPerM
      .subarray(layer * cellCount, (layer + 1) * cellCount).some((value) => value > 0)) {
      hasIce = true;
      iceSupportBottomM = Math.min(iceSupportBottomM, C9_LAYER_EDGES_M[layer]!);
    }
  }
  if (!hasLiquid || !hasIce) throw new Error('C9 fixture must deposit both liquid and ice layers');
  const zeroGapThicknessM = iceSupportBottomM - liquidSupportTopM;
  // 報告用の空隙内消散は名目的な 3–6 km 帯で測る。漏れがあると帯の厚さも削られる。
  let maximumGapExtinctionPerM = 0;
  for (let layer = 0; layer < layerCount; layer += 1) {
    const lower = C9_LAYER_EDGES_M[layer]!;
    const upper = C9_LAYER_EDGES_M[layer + 1]!;
    if (lower < C9_GAP_LOWER_M || upper > C9_GAP_UPPER_M) continue;
    for (let cell = 0; cell < cellCount; cell += 1) {
      maximumGapExtinctionPerM = Math.max(maximumGapExtinctionPerM,
        base.data.liquidExtinctionPerM[layer * cellCount + cell]!
        + base.data.iceExtinctionPerM[layer * cellCount + cell]!);
    }
  }

  // 視差: 層別の重心を 45° の投影方位へ層中央高さぶん地表へ移し、その間隔を測る。
  const liquidPlane = cloudOpticalVolumeLayerPlane(base.data, frameGrid, 0, 'liquid');
  const icePlane = cloudOpticalVolumeLayerPlane(base.data, frameGrid, 2, 'ice');
  const liquidCentroid = fieldValueCentroid(liquidPlane);
  const iceCentroid = fieldValueCentroid(icePlane);
  if (liquidCentroid === null || iceCentroid === null) {
    throw new Error('C9 fixture discs must have nonzero extinction');
  }
  const liquidProjected = projectedCentroid(liquidCentroid, C9_LIQUID_LAYER_CENTER_M);
  const iceProjected = projectedCentroid(iceCentroid, C9_ICE_LAYER_CENTER_M);
  const projectedSeparationM = Math.hypot(
    iceProjected.eastM - liquidProjected.eastM,
    iceProjected.northM - liquidProjected.northM,
  );
  const liquidCentroidErrorM = Math.hypot(
    liquidProjected.eastM - C9_LIQUID_LAYER_CENTER_M, liquidProjected.northM);
  const iceCentroidErrorM = Math.hypot(
    iceProjected.eastM - C9_ICE_LAYER_CENTER_M, iceProjected.northM);

  // 影: 同じ投影で各層の mask を地表へずらし、和集合の支持面積を測る。
  const shadowSupportAreaM2 = unionShiftedSupportAreaM2([
    {
      plane: liquidPlane,
      shiftEastCells: Math.round(C9_LIQUID_LAYER_CENTER_M / C9_CELL_SIZE_M),
      shiftNorthCells: 0,
      memberThreshold: 0,
    },
    {
      plane: icePlane,
      shiftEastCells: Math.round(C9_ICE_LAYER_CENTER_M / C9_CELL_SIZE_M),
      shiftNorthCells: 0,
      memberThreshold: 0,
    },
  ]);
  const analyticShadowSupportAreaM2 = twoDiscUnionAreaM2(
    10_000, C9_ICE_LAYER_CENTER_M - C9_LIQUID_LAYER_CENTER_M);

  // 風の対照: 層中央の高さで別々の風へ 1 時間輸送した円盤を張り直し、重心の変位を測る。
  const windLevels: CloudEnvironmentLevelInput[] = [0, 1_000, 3_000, 6_000, 8_000]
    .map((heightM) => ({
      heightM,
      pressurePa: 101_325,
      temperatureK: 288,
      waterVaporSpecificHumidityKgPerKg: 0.01,
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: heightM >= 1_000 && heightM <= 3_000 ? 10 : 0,
      northWindMps: heightM >= 6_000 ? 10 : 0,
      largeScaleVerticalVelocityMps: 0,
    }));
  const liquidEndDirection = transportDisplacementM(windLevels, C9_LIQUID_LAYER_CENTER_M);
  const iceEndDirection = transportDisplacementM(windLevels, C9_ICE_LAYER_CENTER_M);
  const liquidEndUv = cloudLocalUvAt(liquidEndDirection, frame);
  const iceEndUv = cloudLocalUvAt(iceEndDirection, frame);
  if (liquidEndUv === null || iceEndUv === null) {
    throw new Error('C9 wind-displaced disc centers must stay inside the field domain');
  }
  const displaced = buildC9TwoDiscField(
    { eastM: liquidEndUv.eastM, northM: liquidEndUv.northM },
    { eastM: iceEndUv.eastM, northM: iceEndUv.northM },
  );
  const displacedGrid = {
    originEastM: displaced.frame.gridOriginEastM,
    originNorthM: displaced.frame.gridOriginNorthM,
    cellWidthM: displaced.frame.cellWidthM,
    cellHeightM: displaced.frame.cellHeightM,
  };
  const displacedLiquidCentroid = fieldValueCentroid(
    cloudOpticalVolumeLayerPlane(displaced.data, displacedGrid, 0, 'liquid'));
  const displacedIceCentroid = fieldValueCentroid(
    cloudOpticalVolumeLayerPlane(displaced.data, displacedGrid, 2, 'ice'));
  if (displacedLiquidCentroid === null || displacedIceCentroid === null) {
    throw new Error('C9 displaced discs must have nonzero extinction');
  }
  const liquidDisplacementEastM = displacedLiquidCentroid.eastM;
  const iceDisplacementNorthM = displacedIceCentroid.northM;
  const crossAxisDisplacementM = Math.max(
    Math.abs(displacedLiquidCentroid.northM), Math.abs(displacedIceCentroid.eastM));

  return {
    fixture: 'C9',
    cpuDiagnosticsApplied: true,
    generatedCloudImageFixtureApplied: false,
    controls: {
      discRadiusM: 10_000,
      cellSizeM: C9_CELL_SIZE_M,
      raySteps: C9_RAY_STEPS,
      verticalLiquidTau: verticalPath.liquidTau,
      verticalIceTau: verticalPath.iceTau,
      verticalTotalTau: verticalPath.totalTau,
      verticalTransmittance: verticalPath.transmittance,
      slant45LiquidTau: slantPath.liquidTau,
      slant45IceTau: slantPath.iceTau,
      slant45TotalTau: slantPath.totalTau,
      slant45Transmittance: slantPath.transmittance,
      strictVerticalLiquidTau: strictVertical.liquidOpticalDepth,
      strictVerticalIceTau: strictVertical.iceOpticalDepth,
      strictVerticalTotalTau: strictVertical.liquidOpticalDepth + strictVertical.iceOpticalDepth,
      strictSlant45TotalTau: strictSlant.liquidOpticalDepth + strictSlant.iceOpticalDepth,
      cpuMinusStrictSlant45TotalTau: slantPath.totalTau
        - (strictSlant.liquidOpticalDepth + strictSlant.iceOpticalDepth),
      gpuTauComparisonStatus: 'pending: GPU probe is a render-lab diagnostic; '
        + 'this evaluation compares the shared-rule CPU reference with the analytic values',
      zeroGapThicknessM,
      maximumGapExtinctionPerM,
      liquidCentroidEastM: liquidCentroid.eastM,
      liquidCentroidNorthM: liquidCentroid.northM,
      iceCentroidEastM: iceCentroid.eastM,
      iceCentroidNorthM: iceCentroid.northM,
      projectedSeparationM,
      liquidProjectedCentroidErrorM: liquidCentroidErrorM,
      iceProjectedCentroidErrorM: iceCentroidErrorM,
      shadowSupportAreaM2,
      analyticShadowSupportAreaM2,
      shadowLayerOffsetM: projectedSeparationM,
      windDisplacementEastLiquidM: liquidDisplacementEastM,
      windDisplacementNorthIceM: iceDisplacementNorthM,
      windCrossAxisDisplacementM: crossAxisDisplacementM,
      slantAzimuthRad: C9_SLANT_AZIMUTH_RAD,
    },
    measurements: [
      compare('tau-vertical-liquid', verticalPath.liquidTau, '1',
        C9_VERTICAL_LIQUID_TAU, C9_TAU_TOLERANCE, 'absolute-error',
        'Central vertical path through the liquid layer: beta 2e-4 m^-1 over 2 km.'),
      compare('tau-vertical-ice', verticalPath.iceTau, '1',
        C9_VERTICAL_ICE_TAU, C9_TAU_TOLERANCE, 'absolute-error',
        'Central vertical path through the ice layer: beta 1e-4 m^-1 over 2 km.'),
      compare('tau-vertical', verticalPath.totalTau, '1',
        C9_VERTICAL_TOTAL_TAU, C9_TAU_TOLERANCE, 'absolute-error',
        'Total analytic optical depth 0.4 + 0.2 = 0.6.'),
      compare('transmittance-vertical', verticalPath.transmittance, '1',
        Math.exp(-C9_VERTICAL_TOTAL_TAU), C9_TAU_TOLERANCE, 'absolute-error',
        'exp(-0.6) = 0.5488116361; the tolerance is inherited from the tau gate.'),
      compare('tau-slant-45', slantPath.totalTau, '1',
        C9_SLANT_TOTAL_TAU, C9_TAU_TOLERANCE, 'absolute-error',
        '45-degree center path: 0.6 / cos(45 deg) = 0.8485281374.'),
      compare('transmittance-slant-45', slantPath.transmittance, '1',
        Math.exp(-C9_SLANT_TOTAL_TAU), C9_TAU_TOLERANCE, 'absolute-error',
        'exp(-0.8485281374) = 0.4280444912; the tolerance is inherited from the tau gate.'),
      compare('phase-isolation-liquid-only', liquidOnlyPath.iceTau, '1',
        0, 0, 'absolute-error',
        'The liquid-only control must not contribute any ice optical depth.'),
      compare('phase-isolation-ice-only', iceOnlyPath.liquidTau, '1',
        0, 0, 'absolute-error',
        'The ice-only control must not contribute any liquid optical depth.'),
      compare('layer-gap', zeroGapThicknessM, 'm',
        C9_GAP_THICKNESS_M, 1e-9, 'absolute-error',
        'Thickness of the band with strictly zero extinction in both phases between the layer supports.'),
      compare('parallax', projectedSeparationM / C9_CELL_SIZE_M, 'px',
        10, 2, 'absolute-error',
        '45-degree surface-projected centroid separation of the 2 km and 7 km layer centers: analytic 5 km = 10 cells.'),
      compare('parallax-centroid-liquid', liquidCentroidErrorM, 'm',
        0, C9_CENTROID_TOLERANCE_M, 'absolute-error',
        'Projected liquid-layer centroid error on the 0.5 km grid.'),
      compare('parallax-centroid-ice', iceCentroidErrorM, 'm',
        0, C9_CENTROID_TOLERANCE_M, 'absolute-error',
        'Projected ice-layer centroid error on the 0.5 km grid.'),
      compare('wind-displacement-liquid', liquidDisplacementEastM, 'm',
        C9_WIND_DISPLACEMENT_M, C9_CENTROID_TOLERANCE_M, 'absolute-error',
        'Liquid-layer center advected one hour by the 10 m/s east wind, measured on the re-baked field.'),
      compare('wind-displacement-ice', iceDisplacementNorthM, 'm',
        C9_WIND_DISPLACEMENT_M, C9_CENTROID_TOLERANCE_M, 'absolute-error',
        'Ice-layer center advected one hour by the 10 m/s north wind, measured on the re-baked field.'),
      compare('wind-cross-axis', crossAxisDisplacementM, 'm',
        0, C9_CENTROID_TOLERANCE_M, 'absolute-error',
        'Cross-axis false displacement of both layer centers.'),
      blocked('shadow-support', 'm2',
        `Union shadow support of both projected layers measures ${shadowSupportAreaM2.toFixed(0)} m2 `
        + `(analytic two-disc union ${analyticShadowSupportAreaM2.toFixed(0)} m2, offset `
        + `${projectedSeparationM.toFixed(1)} m); the quantitative support-area acceptance band is not fixed yet.`),
    ],
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
    case 'C8': return evaluateC8();
    case 'C9': return evaluateC9();
  }
}
