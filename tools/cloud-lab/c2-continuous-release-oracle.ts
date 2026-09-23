// C2 の二層風と連続放出を使い、輸送実装に依存しない位置分布の基準を評価する。
import { len, norm, v3 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/math/vec3';
import { massWeightedSphericalRmsSpreadM, sphericalDistanceM } from './spherical-measures';

export const C2_CONTINUOUS_ORACLE_INTERVALS = 32_768;

export interface C2ReleaseCohortEndpoint {
  readonly directionUnitVector: Vec3;
  readonly massKgM2: number;
}

interface ContinuousReleaseDistribution {
  readonly centroid: Vec3;
  readonly spreadM: number;
  readonly massKgM2: number;
  readonly firstMomentMagnitudeSeconds: number;
}

export interface C2ContinuousReleaseOracleInput {
  readonly releaseStartTimeSeconds: number;
  readonly releaseEndTimeSeconds: number;
  readonly sampleTimeSeconds: number;
  readonly sphereRadiusM: number;
  readonly lowerHeightM: number;
  readonly upperHeightM: number;
  readonly lowerEastWindMps: number;
  readonly upperNorthWindMps: number;
  readonly releaseRateKgM2S: number;
  readonly sublimationRatePerSecond: number;
  readonly cohortsByCount: readonly {
    readonly count: number;
    readonly cohorts: readonly C2ReleaseCohortEndpoint[];
  }[];
}

export interface C2ContinuousReleaseOracleResult {
  readonly quadratureRefinementDeltaM: number;
  readonly centroidQuadratureErrorBoundM: number;
  readonly spreadM: number;
  readonly massKgM2: number;
  readonly convergenceErrorsM: readonly number[];
}

/** 輸送積分とは独立に、下層東向き・上層北向きの順で解析位置を求める。 */
export function analyticC2ReleasedIceDirection(
  releaseTimeSeconds: number,
  sampleTimeSeconds: number,
  sphereRadiusM: number,
  lowerHeightM: number,
  upperHeightM: number,
  lowerEastWindMps: number,
  upperNorthWindMps: number,
): Vec3 {
  requireFinite(releaseTimeSeconds, 'releaseTimeSeconds');
  requireFinite(sampleTimeSeconds, 'sampleTimeSeconds');
  requirePositive(sphereRadiusM + lowerHeightM, 'lower sphere radius plus height');
  requirePositive(sphereRadiusM + upperHeightM, 'upper sphere radius plus height');
  requireFinite(lowerEastWindMps, 'lowerEastWindMps');
  requireFinite(upperNorthWindMps, 'upperNorthWindMps');
  const lowerAngleRad = lowerEastWindMps * releaseTimeSeconds / (sphereRadiusM + lowerHeightM);
  const upperAngleRad = upperNorthWindMps * (sampleTimeSeconds - releaseTimeSeconds)
    / (sphereRadiusM + upperHeightM);
  requireFinite(lowerAngleRad, 'lowerAngleRad');
  requireFinite(upperAngleRad, 'upperAngleRad');
  const lowerSine = Math.sin(lowerAngleRad);
  const lowerCosine = Math.cos(lowerAngleRad);
  return v3(
    lowerSine * Math.cos(upperAngleRad),
    Math.sin(upperAngleRad),
    lowerCosine * Math.cos(upperAngleRad),
  );
}

function continuousReleaseDistribution(
  input: C2ContinuousReleaseOracleInput,
  intervalCount: number,
): ContinuousReleaseDistribution {
  const intervalSeconds = (input.releaseEndTimeSeconds - input.releaseStartTimeSeconds) / intervalCount;
  const samples = Array.from({ length: intervalCount }, (_, index) => {
    const releaseTimeSeconds = input.releaseStartTimeSeconds + (index + 0.5) * intervalSeconds;
    return {
      directionUnitVector: analyticC2ReleasedIceDirection(
        releaseTimeSeconds, input.sampleTimeSeconds, input.sphereRadiusM,
        input.lowerHeightM, input.upperHeightM,
        input.lowerEastWindMps, input.upperNorthWindMps,
      ),
      massKgM2: releaseMassKgM2(input, releaseTimeSeconds, intervalSeconds),
    };
  });
  const massKgM2 = samples.reduce((sum, sample) => sum + sample.massKgM2, 0);
  requirePositive(massKgM2, 'quadrature release mass');
  const weightedDirection = samples.reduce((sum, sample) => v3(
    sum.x + sample.directionUnitVector.x * sample.massKgM2,
    sum.y + sample.directionUnitVector.y * sample.massKgM2,
    sum.z + sample.directionUnitVector.z * sample.massKgM2,
  ), v3(0, 0, 0));
  if (len(weightedDirection) <= 64 * Number.EPSILON * massKgM2) {
    throw new RangeError('continuous release centroid is undefined for this interval and wind field');
  }
  requireFinite(len(weightedDirection), 'continuous release first moment');
  const spreadM = massWeightedSphericalRmsSpreadM(samples, input.sphereRadiusM + input.upperHeightM);
  requireFinite(spreadM, 'continuous release RMS spread');
  return {
    centroid: norm(weightedDirection),
    spreadM,
    massKgM2,
    firstMomentMagnitudeSeconds: len(weightedDirection) / input.releaseRateKgM2S,
  };
}

function releaseMassKgM2(
  input: C2ContinuousReleaseOracleInput,
  releaseTimeSeconds: number,
  intervalSeconds: number,
): number {
  const massKgM2 = input.releaseRateKgM2S
    * Math.exp(-input.sublimationRatePerSecond * (input.sampleTimeSeconds - releaseTimeSeconds))
    * intervalSeconds;
  requireFinite(massKgM2, 'quadrature cohort mass');
  return massKgM2;
}

function cohortErrorM(
  cohorts: readonly C2ReleaseCohortEndpoint[],
  reference: ContinuousReleaseDistribution,
  radiusM: number,
): number {
  const weightedDirection = cohorts.reduce((sum, cohort) => v3(
    sum.x + cohort.directionUnitVector.x * cohort.massKgM2,
    sum.y + cohort.directionUnitVector.y * cohort.massKgM2,
    sum.z + cohort.directionUnitVector.z * cohort.massKgM2,
  ), v3(0, 0, 0));
  if (len(weightedDirection) === 0) throw new RangeError('cohort centroid is undefined');
  const centroidErrorM = sphericalDistanceM(norm(weightedDirection), reference.centroid, radiusM);
  const spreadErrorM = Math.abs(massWeightedSphericalRmsSpreadM(cohorts, radiusM) - reference.spreadM);
  const errorM = Math.max(centroidErrorM, spreadErrorM);
  requireFinite(errorM, 'cohort distribution error');
  return errorM;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function validateOracleInput(input: C2ContinuousReleaseOracleInput): void {
  if (typeof input !== 'object' || input === null) throw new TypeError('input must be an object');
  const finiteValues: readonly [number, string][] = [
    [input.releaseStartTimeSeconds, 'releaseStartTimeSeconds'],
    [input.releaseEndTimeSeconds, 'releaseEndTimeSeconds'],
    [input.sampleTimeSeconds, 'sampleTimeSeconds'],
    [input.lowerHeightM, 'lowerHeightM'],
    [input.upperHeightM, 'upperHeightM'],
    [input.lowerEastWindMps, 'lowerEastWindMps'],
    [input.upperNorthWindMps, 'upperNorthWindMps'],
    [input.sublimationRatePerSecond, 'sublimationRatePerSecond'],
  ];
  for (const [value, name] of finiteValues) requireFinite(value, name);
  requirePositive(input.sphereRadiusM, 'sphereRadiusM');
  requirePositive(input.sphereRadiusM + input.lowerHeightM, 'lower sphere radius plus height');
  requirePositive(input.sphereRadiusM + input.upperHeightM, 'upper sphere radius plus height');
  requirePositive(input.releaseRateKgM2S, 'releaseRateKgM2S');
  if (input.sublimationRatePerSecond < 0) {
    throw new RangeError('sublimationRatePerSecond must be non-negative');
  }
  if (input.releaseEndTimeSeconds <= input.releaseStartTimeSeconds) {
    throw new RangeError('release interval must have positive duration');
  }
  requirePositive(input.releaseEndTimeSeconds - input.releaseStartTimeSeconds, 'release duration');
  if (input.sampleTimeSeconds < input.releaseEndTimeSeconds) {
    throw new RangeError('sampleTimeSeconds must not precede the end of release');
  }
  if (!Array.isArray(input.cohortsByCount) || input.cohortsByCount.length === 0) {
    throw new RangeError('cohortsByCount must not be empty');
  }
  for (const cohortSet of input.cohortsByCount) {
    if (typeof cohortSet !== 'object' || cohortSet === null) {
      throw new TypeError('each cohort set must be an object');
    }
    const { count, cohorts } = cohortSet;
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('cohort count must be a positive safe integer');
    }
    if (!Array.isArray(cohorts) || cohorts.length !== count) {
      throw new RangeError(`C2 expected ${count} cohorts, got ${cohorts?.length ?? 'non-array'}`);
    }
    let totalMassKgM2 = 0;
    for (const cohort of cohorts) {
      if (typeof cohort !== 'object' || cohort === null
        || typeof cohort.directionUnitVector !== 'object' || cohort.directionUnitVector === null) {
        throw new TypeError('each cohort must have a direction vector and mass');
      }
      const { directionUnitVector, massKgM2 } = cohort;
      requireFinite(directionUnitVector.x, 'cohort direction x');
      requireFinite(directionUnitVector.y, 'cohort direction y');
      requireFinite(directionUnitVector.z, 'cohort direction z');
      requireFinite(massKgM2, 'cohort massKgM2');
      if (massKgM2 < 0) throw new RangeError('cohort massKgM2 must be non-negative');
      if (Math.abs(len(directionUnitVector) - 1) > 1e-9) {
        throw new RangeError('cohort direction must be a unit vector');
      }
      totalMassKgM2 += massKgM2;
    }
    if (!Number.isFinite(totalMassKgM2) || totalMassKgM2 <= 0) {
      throw new RangeError('cohort masses must have a finite positive sum');
    }
  }
}

/**
 * 固定刻みの高解像度な放出時刻基準と有限コホートを比較する。
 * 導関数による誤差上界は質量加重重心だけに適用し、RMS 広がりの誤差は刻み半減時の差として返す。
 */
export function evaluateC2ContinuousReleaseOracle(
  input: C2ContinuousReleaseOracleInput,
): C2ContinuousReleaseOracleResult {
  validateOracleInput(input);
  const oracle = continuousReleaseDistribution(input, C2_CONTINUOUS_ORACLE_INTERVALS);
  const coarse = continuousReleaseDistribution(input, C2_CONTINUOUS_ORACLE_INTERVALS / 2);
  const radiusM = input.sphereRadiusM + input.upperHeightM;
  const quadratureRefinementDeltaM = sphericalDistanceM(oracle.centroid, coarse.centroid, radiusM)
    + Math.abs(oracle.spreadM - coarse.spreadM);
  requireFinite(quadratureRefinementDeltaM, 'quadrature refinement delta');
  const releaseDurationSeconds = input.releaseEndTimeSeconds - input.releaseStartTimeSeconds;
  const maximumAngularRatePerSecond = Math.abs(input.lowerEastWindMps)
    / (input.sphereRadiusM + input.lowerHeightM)
    + Math.abs(input.upperNorthWindMps) / radiusM;
  const maximumWeightedDirectionSecondDerivative = (
    input.sublimationRatePerSecond + maximumAngularRatePerSecond
  ) ** 2;
  // 複合中点則による方向モーメントの誤差は L^3 * sup|f''| / (24*N^2) 以下。
  // sup|f''| <= (lambda + K)^2 の上界を使う。この上界は非線形な RMS 広がりを含まない。
  const momentErrorBoundSeconds = releaseDurationSeconds ** 3
    * maximumWeightedDirectionSecondDerivative
    / (24 * C2_CONTINUOUS_ORACLE_INTERVALS ** 2);
  requireFinite(oracle.firstMomentMagnitudeSeconds, 'continuous release first moment magnitude');
  requireFinite(momentErrorBoundSeconds, 'centroid moment error bound');
  if (momentErrorBoundSeconds >= oracle.firstMomentMagnitudeSeconds) {
    throw new RangeError('midpoint error bound does not resolve the continuous release centroid');
  }
  const centroidAngleRatio = momentErrorBoundSeconds
    / (oracle.firstMomentMagnitudeSeconds - momentErrorBoundSeconds);
  if (!Number.isFinite(centroidAngleRatio) || centroidAngleRatio > 1) {
    throw new RangeError('midpoint error bound is too large to bound the continuous release centroid angle');
  }
  const centroidAngleErrorBoundRad = Math.asin(
    centroidAngleRatio,
  );
  const convergenceErrorsM = input.cohortsByCount.map(({ count, cohorts }) => {
    if (cohorts.length !== count) throw new RangeError(`C2 expected ${count} cohorts, got ${cohorts.length}`);
    return cohortErrorM(cohorts, oracle, radiusM);
  });
  return {
    quadratureRefinementDeltaM,
    centroidQuadratureErrorBoundM: radiusM * centroidAngleErrorBoundRad,
    spreadM: oracle.spreadM,
    massKgM2: oracle.massKgM2,
    convergenceErrorsM,
  };
}
