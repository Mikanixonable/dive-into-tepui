// Deterministic CPU reconstruction of convective-cloud material tracks. The mass ledger remains
// owned by cloud-events.ts; this module only partitions an already-declared continuous ice release
// into finite cohorts and transports those cohorts without changing their total mass.

import { advectSphericalPositionUnitVector } from '../../physics/cloud-spherical-transport';
import { v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { ConvectiveCloudEvent } from './cloud-events';

export interface CloudEventWind {
  readonly tangentVelocityMPerS: Vec3;
  readonly verticalVelocityMPerS: number;
}

export type CloudEventWindAt = (
  directionUnitVector: Vec3,
  geometricHeightM: number,
  timeSeconds: number,
) => CloudEventWind;

export interface CloudMaterialTrack {
  readonly directionUnitVector: Vec3;
  readonly geometricHeightM: number;
  readonly massKgM2: number;
  readonly steps: number;
}

export interface CloudMaterialCohortTrack extends CloudMaterialTrack {
  readonly id: string;
  readonly releaseStartTimeSeconds: number;
  readonly releaseEndTimeSeconds: number;
  readonly representativeReleaseTimeSeconds: number;
  readonly releasedKgM2: number;
  readonly remainingKgM2: number;
}

export interface CloudEventMaterialTracks {
  readonly parent: CloudMaterialTrack | null;
  readonly releasedIce: CloudMaterialTrack | null;
  readonly totalMassKgM2: number;
}

export interface CloudEventMaterialCohorts {
  readonly parent: CloudMaterialTrack | null;
  readonly releasedIceCohorts: readonly CloudMaterialCohortTrack[];
  readonly totalMassKgM2: number;
  readonly totalReleasedIceMassKgM2: number;
}

const MAX_TRANSPORT_STEPS = 1_000_000;
const MAX_RELEASE_COHORTS = 4_096;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function exponentialIntegral(durationSeconds: number, decayRatePerSecond: number): number {
  if (durationSeconds <= 0) return 0;
  if (decayRatePerSecond <= 1e-15) return durationSeconds;
  return -Math.expm1(-decayRatePerSecond * durationSeconds) / decayRatePerSecond;
}

function meanAgeAtReleaseEndSeconds(durationSeconds: number, lossRatePerSecond: number): number {
  if (durationSeconds <= 0) return 0;
  const x = lossRatePerSecond * durationSeconds;
  if (x < 1e-4) {
    return durationSeconds / 2
      - lossRatePerSecond * durationSeconds ** 2 / 12
      + lossRatePerSecond ** 3 * durationSeconds ** 4 / 720;
  }
  if (x > 50) return 1 / lossRatePerSecond;
  return 1 / lossRatePerSecond - durationSeconds / Math.expm1(x);
}

export function reconstructCloudMaterialTrack(
  startDirectionUnitVector: Vec3,
  startHeightM: number,
  startTimeSeconds: number,
  endTimeSeconds: number,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
  massKgM2: number,
): CloudMaterialTrack {
  requirePositive(sphereRadiusM, 'sphereRadiusM');
  requirePositive(maxStepSeconds, 'maxStepSeconds');
  requireFinite(startHeightM, 'startHeightM');
  requireFinite(startTimeSeconds, 'startTimeSeconds');
  requireFinite(endTimeSeconds, 'endTimeSeconds');
  requireFinite(massKgM2, 'massKgM2');
  if (massKgM2 < 0) throw new RangeError('massKgM2 must be non-negative');
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');

  const elapsedSeconds = endTimeSeconds - startTimeSeconds;
  if (elapsedSeconds < 0) throw new RangeError('track start time must not follow the sample time');
  const stepCount = Math.ceil(elapsedSeconds / maxStepSeconds);
  if (stepCount > MAX_TRANSPORT_STEPS) {
    throw new RangeError(`transport requires more than ${MAX_TRANSPORT_STEPS} steps`);
  }

  let direction = advectSphericalPositionUnitVector(
    startDirectionUnitVector, v3(0, 0, 0), sphereRadiusM, 0,
  );
  let height = startHeightM;
  const stepSeconds = stepCount === 0 ? 0 : elapsedSeconds / stepCount;
  for (let index = 0; index < stepCount; index += 1) {
    const timeSeconds = startTimeSeconds + stepSeconds * index;
    const wind = windAt(direction, height, timeSeconds);
    requireFinite(wind.tangentVelocityMPerS.x, 'tangentVelocityMPerS.x');
    requireFinite(wind.tangentVelocityMPerS.y, 'tangentVelocityMPerS.y');
    requireFinite(wind.tangentVelocityMPerS.z, 'tangentVelocityMPerS.z');
    requireFinite(wind.verticalVelocityMPerS, 'verticalVelocityMPerS');
    direction = advectSphericalPositionUnitVector(
      direction, wind.tangentVelocityMPerS, sphereRadiusM + height, stepSeconds,
    );
    height += wind.verticalVelocityMPerS * stepSeconds;
    requireFinite(height, 'geometricHeightM');
    if (sphereRadiusM + height <= 0) throw new RangeError('sphere radius plus height must be positive');
  }
  return { directionUnitVector: direction, geometricHeightM: height, massKgM2, steps: stepCount };
}

function parentTrack(
  event: ConvectiveCloudEvent,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
): CloudMaterialTrack | null {
  if (event.mass.liquidKgM2 <= 0) return null;
  if (event.sourcePosition === undefined) {
    throw new RangeError('event sourcePosition is required to reconstruct its parent track');
  }
  return reconstructCloudMaterialTrack(
    event.sourcePosition.directionUnitVector,
    event.sourcePosition.geometricHeightM,
    event.birthTimeSeconds,
    event.birthTimeSeconds + event.ageSeconds,
    sphereRadiusM,
    maxStepSeconds,
    windAt,
    event.mass.liquidKgM2,
  );
}

export function reconstructCloudEventMaterialCohorts(
  event: ConvectiveCloudEvent,
  sphereRadiusM: number,
  maxStepSeconds: number,
  cohortDurationSeconds: number,
  windAt: CloudEventWindAt,
): CloudEventMaterialCohorts {
  requirePositive(sphereRadiusM, 'sphereRadiusM');
  requirePositive(maxStepSeconds, 'maxStepSeconds');
  requirePositive(cohortDurationSeconds, 'cohortDurationSeconds');
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');

  const parent = parentTrack(event, sphereRadiusM, maxStepSeconds, windAt);
  const sampleTimeSeconds = event.birthTimeSeconds + event.ageSeconds;
  const release = event.iceRelease;
  const releasedIceCohorts: CloudMaterialCohortTrack[] = [];

  if (release.remainingKgM2 > 0) {
    if (event.sourcePosition === undefined) {
      throw new RangeError('event sourcePosition is required to reconstruct released ice');
    }
    if (release.releaseHeightM === null
      || release.releaseStartTimeSeconds === null
      || release.releaseEndTimeSeconds === null) {
      throw new RangeError('released ice requires a release interval and height');
    }
    const releaseDurationSeconds = release.releaseEndTimeSeconds - release.releaseStartTimeSeconds;
    if (!(releaseDurationSeconds > 0)) throw new RangeError('ice release interval must be positive');
    const cohortCount = Math.ceil(releaseDurationSeconds / cohortDurationSeconds);
    if (cohortCount > MAX_RELEASE_COHORTS) {
      throw new RangeError(`ice release requires more than ${MAX_RELEASE_COHORTS} cohorts`);
    }

    for (let index = 0; index < cohortCount; index += 1) {
      const segmentStart = release.releaseStartTimeSeconds + cohortDurationSeconds * index;
      const segmentEnd = Math.min(
        release.releaseEndTimeSeconds, segmentStart + cohortDurationSeconds,
      );
      const durationSeconds = segmentEnd - segmentStart;
      const releasedKgM2 = release.releaseRateKgM2S * durationSeconds;
      const remainingKgM2 = release.releaseRateKgM2S
        * Math.exp(-release.lossRatePerSecond * Math.max(sampleTimeSeconds - segmentEnd, 0))
        * exponentialIntegral(durationSeconds, release.lossRatePerSecond);
      if (!(remainingKgM2 > 0)) continue;
      const representativeReleaseTimeSeconds = segmentEnd
        - meanAgeAtReleaseEndSeconds(durationSeconds, release.lossRatePerSecond);
      const releaseOrigin = reconstructCloudMaterialTrack(
        event.sourcePosition.directionUnitVector,
        event.sourcePosition.geometricHeightM,
        event.birthTimeSeconds,
        representativeReleaseTimeSeconds,
        sphereRadiusM,
        maxStepSeconds,
        windAt,
        0,
      );
      const track = reconstructCloudMaterialTrack(
        releaseOrigin.directionUnitVector,
        release.releaseHeightM,
        representativeReleaseTimeSeconds,
        sampleTimeSeconds,
        sphereRadiusM,
        maxStepSeconds,
        windAt,
        remainingKgM2,
      );
      releasedIceCohorts.push({
        ...track,
        id: `${release.id}:cohort-${index}`,
        releaseStartTimeSeconds: segmentStart,
        releaseEndTimeSeconds: segmentEnd,
        representativeReleaseTimeSeconds,
        releasedKgM2,
        remainingKgM2,
      });
    }
  }

  const cohortRemainingKgM2 = releasedIceCohorts.reduce(
    (sum, cohort) => sum + cohort.remainingKgM2, 0,
  );
  const massTolerance = Math.max(1e-12, release.remainingKgM2 * 1e-10);
  if (Math.abs(cohortRemainingKgM2 - release.remainingKgM2) > massTolerance) {
    throw new RangeError('released-ice cohort partition does not preserve the event mass ledger');
  }
  return {
    parent,
    releasedIceCohorts: Object.freeze(releasedIceCohorts),
    totalMassKgM2: (parent?.massKgM2 ?? 0) + cohortRemainingKgM2,
    totalReleasedIceMassKgM2: releasedIceCohorts.reduce(
      (sum, cohort) => sum + cohort.releasedKgM2, 0,
    ),
  };
}

export function reconstructCloudEventMaterialTracks(
  event: ConvectiveCloudEvent,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
): CloudEventMaterialTracks {
  const releaseStart = event.iceRelease.releaseStartTimeSeconds;
  const releaseEnd = event.iceRelease.releaseEndTimeSeconds;
  const releaseDurationSeconds = releaseStart === null || releaseEnd === null
    ? 1
    : Math.max(releaseEnd - releaseStart, Number.EPSILON);
  const cohorts = reconstructCloudEventMaterialCohorts(
    event, sphereRadiusM, maxStepSeconds, releaseDurationSeconds, windAt,
  );
  return {
    parent: cohorts.parent,
    releasedIce: cohorts.releasedIceCohorts[0] ?? null,
    totalMassKgM2: cohorts.totalMassKgM2,
  };
}
