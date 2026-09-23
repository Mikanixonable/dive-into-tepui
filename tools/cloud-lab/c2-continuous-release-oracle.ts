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
  const lowerAngleRad = lowerEastWindMps * releaseTimeSeconds / (sphereRadiusM + lowerHeightM);
  const upperAngleRad = upperNorthWindMps * (sampleTimeSeconds - releaseTimeSeconds)
    / (sphereRadiusM + upperHeightM);
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
      massKgM2: input.releaseRateKgM2S
        * Math.exp(-input.sublimationRatePerSecond * (input.sampleTimeSeconds - releaseTimeSeconds))
        * intervalSeconds,
    };
  });
  const massKgM2 = samples.reduce((sum, sample) => sum + sample.massKgM2, 0);
  const weightedDirection = samples.reduce((sum, sample) => v3(
    sum.x + sample.directionUnitVector.x * sample.massKgM2,
    sum.y + sample.directionUnitVector.y * sample.massKgM2,
    sum.z + sample.directionUnitVector.z * sample.massKgM2,
  ), v3(0, 0, 0));
  return {
    centroid: norm(weightedDirection),
    spreadM: massWeightedSphericalRmsSpreadM(samples, input.sphereRadiusM + input.upperHeightM),
    massKgM2,
    firstMomentMagnitudeSeconds: len(weightedDirection) / input.releaseRateKgM2S,
  };
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
  const centroidErrorM = sphericalDistanceM(norm(weightedDirection), reference.centroid, radiusM);
  const spreadErrorM = Math.abs(massWeightedSphericalRmsSpreadM(cohorts, radiusM) - reference.spreadM);
  return Math.max(centroidErrorM, spreadErrorM);
}

/**
 * 固定刻みの高解像度な放出時刻基準と有限コホートを比較する。
 * 導関数による誤差上界は質量加重重心だけに適用し、RMS 広がりの誤差は刻み半減時の差として返す。
 */
export function evaluateC2ContinuousReleaseOracle(
  input: C2ContinuousReleaseOracleInput,
): C2ContinuousReleaseOracleResult {
  const oracle = continuousReleaseDistribution(input, C2_CONTINUOUS_ORACLE_INTERVALS);
  const coarse = continuousReleaseDistribution(input, C2_CONTINUOUS_ORACLE_INTERVALS / 2);
  const radiusM = input.sphereRadiusM + input.upperHeightM;
  const quadratureRefinementDeltaM = sphericalDistanceM(oracle.centroid, coarse.centroid, radiusM)
    + Math.abs(oracle.spreadM - coarse.spreadM);
  const releaseDurationSeconds = input.releaseEndTimeSeconds - input.releaseStartTimeSeconds;
  const maximumAngularRatePerSecond = input.lowerEastWindMps / (input.sphereRadiusM + input.lowerHeightM)
    + input.upperNorthWindMps / radiusM;
  const maximumWeightedDirectionSecondDerivative = (
    input.sublimationRatePerSecond + maximumAngularRatePerSecond
  ) ** 2;
  // 複合中点則による方向モーメントの誤差は L^3 * sup|f''| / (24*N^2) 以下。
  // sup|f''| <= (lambda + K)^2 の上界を使う。この上界は非線形な RMS 広がりを含まない。
  const momentErrorBoundSeconds = releaseDurationSeconds ** 3
    * maximumWeightedDirectionSecondDerivative
    / (24 * C2_CONTINUOUS_ORACLE_INTERVALS ** 2);
  const centroidAngleErrorBoundRad = Math.asin(
    momentErrorBoundSeconds / (oracle.firstMomentMagnitudeSeconds - momentErrorBoundSeconds),
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
