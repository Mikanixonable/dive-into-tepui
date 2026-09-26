// 標本した対流イベントの独立した材料軌道を復元する。決定的な CPU の表示導出で、
// イベントの質量 ledger には触れない。輸送へ渡す風の標準供給 — 共有の大気風モデルを
// 輸送風の口へ写すアダプタ — もここに置く。

import { advectSphericalPositionUnitVector } from '../../physics/cloud-spherical-transport';
import { v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import { splitCloudIceReleaseIntoCohorts, type ConvectiveCloudEvent } from './cloud-events';
import { cloudEquirectTangentBasisAt } from './cloud-equirect-grid';
import type { AtmosphericWindField } from '../../render/cloud/atmospheric-wind';

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

export interface CloudIceMaterialCohort extends CloudMaterialTrack {
  readonly cohortIndex: number;
  readonly releaseStartTimeSeconds: number;
  readonly releaseEndTimeSeconds: number;
  readonly meanReleaseTimeSeconds: number;
}

export interface CloudEventMaterialCohorts {
  readonly parent: CloudMaterialTrack | null;
  readonly releasedIceCohorts: readonly CloudIceMaterialCohort[];
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

// 液水の親の軌道。親の凝結物は出生の位置から標本時刻までの軌道を復元する。
// 液水を持たないイベントでは null。
function reconstructParentTrack(
  event: ConvectiveCloudEvent,
  sampleTimeSeconds: number,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
): CloudMaterialTrack | null {
  if (event.mass.liquidKgM2 <= 0) return null;
  if (event.sourcePosition === undefined) {
    throw new RangeError('event sourcePosition is required to reconstruct its parent track');
  }
  return reconstructTrack(
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

// 同じイベントを同じ時刻で標本すると常に同じ2本の軌道が返る。親の凝結物は出生から
// 追う。集約した氷放出コホートは、質量重み付けの代表放出時刻に親の移流済み源位置を
// 継ぎ、設定された放出高度から上層の流れを辿る。ledger は連続放出を集約しているので、
// この代表軌道は氷の空間的な広がり全体は再現しない。
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
  const parent = reconstructParentTrack(event, sampleTimeSeconds, sphereRadiusM, maxStepSeconds, windAt);

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

/** 各放出時間帯の質量と代表位置を風場から復元する。 */
export function reconstructCloudEventMaterialCohorts(
  event: ConvectiveCloudEvent,
  sphereRadiusM: number,
  maxStepSeconds: number,
  windAt: CloudEventWindAt,
  cohortCount = 32,
): CloudEventMaterialCohorts {
  requirePositive(sphereRadiusM, 'sphereRadiusM');
  requirePositive(maxStepSeconds, 'maxStepSeconds');
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');
  const sampleTimeSeconds = event.birthTimeSeconds + event.ageSeconds;
  requireFinite(sampleTimeSeconds, 'sampleTimeSeconds');
  const parent = reconstructParentTrack(event, sampleTimeSeconds, sphereRadiusM, maxStepSeconds, windAt);

  const releaseCohorts = splitCloudIceReleaseIntoCohorts(event, cohortCount);
  const sourcePosition = event.sourcePosition;
  const releaseHeightM = event.iceRelease.releaseHeightM;
  if (releaseCohorts.length > 0 && sourcePosition === undefined) {
    throw new RangeError('event sourcePosition is required to reconstruct released ice cohorts');
  }
  if (releaseCohorts.length > 0 && releaseHeightM === null) {
    throw new RangeError('released ice cohorts require a release height');
  }
  const releasedIceCohorts = releaseCohorts.map((cohort) => {
    if (sourcePosition === undefined || releaseHeightM === null) {
      throw new Error('validated ice cohort source is unavailable');
    }
    const releaseOrigin = reconstructTrack(
      sourcePosition.directionUnitVector,
      sourcePosition.geometricHeightM,
      event.birthTimeSeconds,
      cohort.meanReleaseTimeSeconds,
      sphereRadiusM,
      maxStepSeconds,
      windAt,
      0,
    );
    const track = reconstructTrack(
      releaseOrigin.directionUnitVector,
      releaseHeightM,
      cohort.meanReleaseTimeSeconds,
      sampleTimeSeconds,
      sphereRadiusM,
      maxStepSeconds,
      windAt,
      cohort.remainingKgM2,
    );
    return {
      ...track,
      cohortIndex: cohort.index,
      releaseStartTimeSeconds: cohort.releaseStartTimeSeconds,
      releaseEndTimeSeconds: cohort.releaseEndTimeSeconds,
      meanReleaseTimeSeconds: cohort.meanReleaseTimeSeconds,
    };
  });
  const releasedIceMassKgM2 = releasedIceCohorts.reduce(
    (total, cohort) => total + cohort.massKgM2,
    0,
  );
  const massToleranceKgM2 = 128 * Number.EPSILON * Math.max(1, event.iceRelease.remainingKgM2);
  if (Math.abs(releasedIceMassKgM2 - event.iceRelease.remainingKgM2) > massToleranceKgM2) {
    throw new RangeError('released ice cohort masses do not match the event ice ledger');
  }
  return {
    parent,
    releasedIceCohorts,
    totalMassKgM2: (parent?.massKgM2 ?? 0) + releasedIceMassKgM2,
  };
}

// 共有の大気風モデルを輸送風の口へ写す。大気風モデルをイベント位置の緯度と高さで
// 評価し、位置の接平面基底で東・北成分から接線速度へ戻す。鉛直流は surrogate では
// 扱わない。
export function cloudEventWindAt(windField: AtmosphericWindField): CloudEventWindAt {
  return (directionUnitVector, geometricHeightM) => {
    const latitudeRad = Math.asin(Math.min(Math.max(directionUnitVector.y, -1), 1));
    const { eastUnitVector, northUnitVector } = cloudEquirectTangentBasisAt(directionUnitVector);
    const wind = windField.sample(latitudeRad, geometricHeightM);
    return {
      tangentVelocityMPerS: v3(
        eastUnitVector.x * wind.east + northUnitVector.x * wind.north,
        eastUnitVector.y * wind.east + northUnitVector.y * wind.north,
        eastUnitVector.z * wind.east + northUnitVector.z * wind.north,
      ),
      verticalVelocityMPerS: 0,
    };
  };
}
