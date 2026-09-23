// Reconstructs independent material tracks for a sampled convective event. This is a
// deterministic CPU display derivation; it does not change the event's mass ledger.

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

export interface CloudEventMaterialTracks {
  readonly parent: CloudMaterialTrack | null;
  readonly releasedIce: CloudMaterialTrack | null;
  readonly totalMassKgM2: number;
}

const MAX_TRANSPORT_STEPS = 1_000_000;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function reconstructTrack(
  startDirectionUnitVector: Vec3,
  startHeightM: number,
  startTimeSeconds: number,
  endTimeSeconds: number,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
  massKgM2: number,
): CloudMaterialTrack {
  const elapsedSeconds = endTimeSeconds - startTimeSeconds;
  const stepCount = Math.ceil(elapsedSeconds / maxStepSeconds);
  if (stepCount > MAX_TRANSPORT_STEPS) {
    throw new RangeError(`transport requires more than ${MAX_TRANSPORT_STEPS} steps`);
  }
  if (elapsedSeconds < 0) throw new RangeError('track start time must not follow the sample time');
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

// Samples the same event at the same time to reconstruct the same two tracks. Parent
// condensate starts at birth. The aggregate released-ice cohort inherits the parent's
// advected source position at its mass-weighted mean release time, then follows the upper
// flow from its configured release altitude. Because the ledger aggregates continuous
// releases, this representative path does not reproduce the full spatial spread of ice.
export function reconstructCloudEventMaterialTracks(
  event: ConvectiveCloudEvent,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
): CloudEventMaterialTracks {
  requirePositive(sphereRadiusM, 'sphereRadiusM');
  requirePositive(maxStepSeconds, 'maxStepSeconds');
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');
  const sampleTimeSeconds = event.birthTimeSeconds + event.ageSeconds;
  requireFinite(sampleTimeSeconds, 'sampleTimeSeconds');

  let parent: CloudMaterialTrack | null = null;
  if (event.mass.liquidKgM2 > 0) {
    if (event.sourcePosition === undefined) {
      throw new RangeError('event sourcePosition is required to reconstruct its parent track');
    }
    parent = reconstructTrack(
      event.sourcePosition.directionUnitVector,
      event.sourcePosition.geometricHeightM,
      event.birthTimeSeconds,
      sampleTimeSeconds,
      sphereRadiusM,
      maxStepSeconds,
      windAt,
      event.mass.liquidKgM2,
    );
  }

  let releasedIce: CloudMaterialTrack | null = null;
  const iceMassKgM2 = event.iceRelease.remainingKgM2;
  if (iceMassKgM2 > 0) {
    if (event.sourcePosition === undefined) {
      throw new RangeError('event sourcePosition is required to reconstruct released ice');
    }
    if (event.iceRelease.meanReleaseTimeSeconds === null || event.iceRelease.releaseHeightM === null) {
      throw new RangeError('released ice requires a release time and height');
    }
    const releaseOrigin = reconstructTrack(
      event.sourcePosition.directionUnitVector,
      event.sourcePosition.geometricHeightM,
      event.birthTimeSeconds,
      event.iceRelease.meanReleaseTimeSeconds,
      sphereRadiusM,
      maxStepSeconds,
      windAt,
      0,
    );
    releasedIce = reconstructTrack(
      releaseOrigin.directionUnitVector,
      event.iceRelease.releaseHeightM,
      event.iceRelease.meanReleaseTimeSeconds,
      sampleTimeSeconds,
      sphereRadiusM,
      maxStepSeconds,
      windAt,
      iceMassKgM2,
    );
  }

  return {
    parent,
    releasedIce,
    totalMassKgM2: (parent?.massKgM2 ?? 0) + (releasedIce?.massKgM2 ?? 0),
  };
}
