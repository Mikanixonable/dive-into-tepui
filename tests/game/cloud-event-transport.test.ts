import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { add, cross, dot, len, norm, projectOntoPlane, rotateAxis, scale, v3 } from '../../src/math/vec3';
import { reconstructCloudParcel } from '../../src/game/cloud/cloud-parcel-transport';
import type { CloudParcelWindAt } from '../../src/game/cloud/cloud-parcel-transport';
import { reconstructCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-transport';
import type { CloudEventWindAt } from '../../src/game/cloud/cloud-event-transport';
import { sampleConvectiveCloudEvents } from '../../src/game/cloud/cloud-events';

const SPHERE_RADIUS_M = 6_371_000;
const START_DIRECTION = norm(v3(0.7, -0.2, 0.6855654600401044));

function angularDistanceM(first: ReturnType<typeof v3>, second: ReturnType<typeof v3>, radiusM: number): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(first), norm(second))))) * radiusM;
}

function eastAt(directionUnitVector: ReturnType<typeof v3>): ReturnType<typeof v3> {
  const referenceAxis = Math.abs(directionUnitVector.y) > 0.9 ? v3(1, 0, 0) : v3(0, 0, 1);
  return norm(cross(referenceAxis, directionUnitVector));
}

function northAt(directionUnitVector: ReturnType<typeof v3>): ReturnType<typeof v3> {
  return norm(projectOntoPlane(v3(0, 0, 1), directionUnitVector));
}

function solidBodyWindAt(angularVelocityRadPerS: number): CloudParcelWindAt {
  const angularVelocity = v3(0, 0, angularVelocityRadPerS);
  return (directionUnitVector, geometricHeightM) => ({
    tangentVelocityMPerS: cross(
      angularVelocity,
      scale(directionUnitVector, SPHERE_RADIUS_M + geometricHeightM),
    ),
    verticalVelocityMPerS: 0,
  });
}

export function register(): void {
  test('cloud parcel transport: solid-body spherical rotation converges to the Rodrigues solution', () => {
    const angularVelocityRadPerS = 7.292115e-5;
    const durationS = 6 * 3600;
    const expected = rotateAxis(START_DIRECTION, v3(0, 0, 1), angularVelocityRadPerS * durationS);
    const windAt = solidBodyWindAt(angularVelocityRadPerS);
    const coarse = reconstructCloudParcel(
      START_DIRECTION, 0, SPHERE_RADIUS_M, 0, durationS, 600, windAt,
    );
    const medium = reconstructCloudParcel(
      START_DIRECTION, 0, SPHERE_RADIUS_M, 0, durationS, 150, windAt,
    );
    const fine = reconstructCloudParcel(
      START_DIRECTION, 0, SPHERE_RADIUS_M, 0, durationS, 37.5, windAt,
    );
    const reference = reconstructCloudParcel(
      START_DIRECTION, 0, SPHERE_RADIUS_M, 0, durationS, 0.25, windAt,
    );
    const coarseErrorM = angularDistanceM(coarse.directionUnitVector, expected, SPHERE_RADIUS_M);
    const mediumErrorM = angularDistanceM(medium.directionUnitVector, expected, SPHERE_RADIUS_M);
    const fineErrorM = angularDistanceM(fine.directionUnitVector, expected, SPHERE_RADIUS_M);
    const referenceErrorM = angularDistanceM(reference.directionUnitVector, expected, SPHERE_RADIUS_M);

    assert.ok(mediumErrorM < coarseErrorM);
    assert.ok(fineErrorM < mediumErrorM);
    assert.ok(referenceErrorM < 1);
    assert.ok(coarseErrorM < 5_000, 'error must stay below one quarter of 20 km sample spacing');
    assert.equal(coarse.steps, 36);
    assert.equal(medium.steps, 144);
  });

  test('cloud parcel transport: signed time, zero duration, and repeat calls are deterministic', () => {
    const constantEastWind: CloudParcelWindAt = (directionUnitVector) => ({
      tangentVelocityMPerS: scale(eastAt(directionUnitVector), 100),
      verticalVelocityMPerS: 0,
    });
    const eastward = reconstructCloudParcel(
      v3(1, 0, 0), 0, SPHERE_RADIUS_M, 10, 110, 10, constantEastWind,
    );
    const westward = reconstructCloudParcel(
      v3(1, 0, 0), 0, SPHERE_RADIUS_M, 110, 10, 10, constantEastWind,
    );
    const roundTrip = reconstructCloudParcel(
      eastward.directionUnitVector, eastward.geometricHeightM,
      SPHERE_RADIUS_M, 110, 10, 10, constantEastWind,
    );
    let sampled = false;
    const still = reconstructCloudParcel(
      START_DIRECTION, 123, SPHERE_RADIUS_M, 42, 42, 5,
      () => { sampled = true; throw new Error('zero-time transport must not sample the wind'); },
    );
    assert.ok(eastward.directionUnitVector.y > 0);
    assert.ok(westward.directionUnitVector.y < 0);
    assert.ok(angularDistanceM(roundTrip.directionUnitVector, v3(1, 0, 0), SPHERE_RADIUS_M) < 1);
    assert.equal(still.steps, 0);
    assert.equal(still.geometricHeightM, 123);
    assert.ok(angularDistanceM(still.directionUnitVector, START_DIRECTION, SPHERE_RADIUS_M) < 1e-3);
    assert.equal(sampled, false);
    assert.deepEqual(eastward, reconstructCloudParcel(
      v3(1, 0, 0), 0, SPHERE_RADIUS_M, 10, 110, 10, constantEastWind,
    ));
  });

  test('cloud parcel transport: altitude-dependent east and north winds separate and vertical motion is independent', () => {
    const shearedWind: CloudParcelWindAt = (directionUnitVector, geometricHeightM) => ({
      tangentVelocityMPerS: geometricHeightM < 5_000
        ? scale(eastAt(directionUnitVector), 120)
        : scale(northAt(directionUnitVector), 80),
      verticalVelocityMPerS: geometricHeightM < 5_000 ? 0 : 3,
    });
    const low = reconstructCloudParcel(v3(1, 0, 0), 1_000, SPHERE_RADIUS_M, 0, 100, 5, shearedWind);
    const upper = reconstructCloudParcel(v3(1, 0, 0), 10_000, SPHERE_RADIUS_M, 0, 100, 5, shearedWind);

    assert.ok(low.directionUnitVector.y > 0);
    assert.ok(Math.abs(low.directionUnitVector.z) < 1e-10);
    assert.ok(upper.directionUnitVector.z > 0);
    assert.ok(Math.abs(upper.directionUnitVector.y) < 1e-10);
    assert.equal(low.geometricHeightM, 1_000);
    assert.equal(upper.geometricHeightM, 10_300);
  });

  test('cloud parcel transport: polar directions remain finite without a longitude singularity', () => {
    const windAt: CloudParcelWindAt = (directionUnitVector) => ({
      tangentVelocityMPerS: scale(eastAt(directionUnitVector), 100),
      verticalVelocityMPerS: 0,
    });
    for (const direction of [v3(0, 1, 0), v3(0, 1, 1e-12)]) {
      const result = reconstructCloudParcel(direction, 0, SPHERE_RADIUS_M, 0, 100, 1, windAt);
      assert.ok(Number.isFinite(result.directionUnitVector.x));
      assert.ok(Number.isFinite(result.directionUnitVector.y));
      assert.ok(Number.isFinite(result.directionUnitVector.z));
      assert.ok(Math.abs(len(result.directionUnitVector) - 1) < 1e-12);
    }
  });

  test('cloud parcel transport: invalid inputs and excessive step counts are rejected', () => {
    const calmWind: CloudParcelWindAt = () => ({
      tangentVelocityMPerS: v3(0, 0, 0),
      verticalVelocityMPerS: 0,
    });
    const reconstruct = (timeS: number, maxStepS: number, radiusM = SPHERE_RADIUS_M) =>
      reconstructCloudParcel(v3(1, 0, 0), 0, radiusM, 0, timeS, maxStepS, calmWind);
    assert.throws(() => reconstruct(1, 0), RangeError);
    assert.throws(() => reconstruct(1, -1), RangeError);
    assert.throws(() => reconstruct(1, 1, 0), RangeError);
    assert.throws(() => reconstruct(Infinity, 1), RangeError);
    assert.throws(() => reconstruct(1_000_001, 1e-6), RangeError);
    assert.throws(() => reconstructCloudParcel(
      v3(1, 0, 0), -SPHERE_RADIUS_M, SPHERE_RADIUS_M, 0, 0, 1, calmWind,
    ), RangeError);
    assert.throws(() => reconstructCloudParcel(
      v3(0, 0, 0), 0, SPHERE_RADIUS_M, 0, 1, 1, calmWind,
    ), RangeError);
    assert.throws(() => reconstructCloudParcel(
      v3(1, 0, 0), 0, 100, 0, 100, 100,
      () => ({ tangentVelocityMPerS: v3(0, 0, 0), verticalVelocityMPerS: -1.5 }),
    ), RangeError);
    assert.throws(() => reconstructCloudParcel(
      v3(1, 0, 0), 0, SPHERE_RADIUS_M, 0, 1, 1,
      () => ({ tangentVelocityMPerS: v3(0, 0, 0), verticalVelocityMPerS: Number.NaN }),
    ), RangeError);
    assert.throws(() => reconstructCloudParcel(
      v3(1, 0, 0), 0, SPHERE_RADIUS_M, 0, 1, 1,
      () => ({ tangentVelocityMPerS: v3(1, 0, 0), verticalVelocityMPerS: 0 }),
    ), RangeError);
  });

  test('cloud event transport: sampled ledger mass is conserved across analytic two-layer tracks', () => {
    const event = sampleConvectiveCloudEvents({
      seed: 17,
      birthIntervalSeconds: 86_400,
      historyHorizonSeconds: 10_000,
      maximumOmittedMassKgM2: 1,
      maxEventCount: 8,
      timeSeconds: 7_200,
      cells: [{
        id: 'mass-conservation-cell',
        supplySourceId: 'mass-conservation-source',
        convectivePotential: 1,
        upperRelativeHumidity: 0.8,
        liquidSupplyRateKgM2S: 1e-5,
        convectiveDurationSeconds: 3_600,
        sourcePosition: { directionUnitVector: v3(1, 0, 0), geometricHeightM: 1_000 },
        iceReleaseHeightM: 6_000,
      }],
    }).events[0];
    assert.ok(event, 'the deterministic event must be sampled');
    const lowerAngularVelocityRadPerS = 1e-5;
    const upperAngularVelocityRadPerS = 1.5e-5;
    const windAt: CloudEventWindAt = (direction, height) => ({
      tangentVelocityMPerS: add(cross(
        v3(0, 0, height < 5_000 ? lowerAngularVelocityRadPerS : 0),
        scale(direction, SPHERE_RADIUS_M + height),
      ), cross(
        v3(0, height < 5_000 ? 0 : upperAngularVelocityRadPerS, 0),
        scale(direction, SPHERE_RADIUS_M + height),
      )),
      verticalVelocityMPerS: 0,
    });

    const material = reconstructCloudEventMaterialCohorts(event, SPHERE_RADIUS_M, 10, windAt, 16);
    const reconstructedIceMassKgM2 = material.releasedIceCohorts.reduce(
      (total, cohort) => total + cohort.massKgM2,
      0,
    );
    const expectedTotalMassKgM2 = event.mass.liquidKgM2 + event.iceRelease.remainingKgM2;
    assert.ok(event.mass.liquidKgM2 > 0);
    assert.ok(event.iceRelease.remainingKgM2 > 0);
    assert.ok(Math.abs(reconstructedIceMassKgM2 - event.iceRelease.remainingKgM2) < 1e-12);
    assert.ok(Math.abs(material.totalMassKgM2 - expectedTotalMassKgM2) < 1e-12);
    assert.ok(material.parent);
    const expectedParent = rotateAxis(
      v3(1, 0, 0), v3(0, 0, 1), lowerAngularVelocityRadPerS * 7_200,
    );
    assert.ok(angularDistanceM(material.parent.directionUnitVector, expectedParent, SPHERE_RADIUS_M) < 1);

    for (const cohort of material.releasedIceCohorts) {
      const lowerTrack = rotateAxis(
        v3(1, 0, 0), v3(0, 0, 1), lowerAngularVelocityRadPerS * cohort.meanReleaseTimeSeconds,
      );
      const expectedCohort = rotateAxis(
        lowerTrack,
        v3(0, 1, 0),
        upperAngularVelocityRadPerS * (7_200 - cohort.meanReleaseTimeSeconds),
      );
      assert.ok(
        angularDistanceM(cohort.directionUnitVector, expectedCohort, SPHERE_RADIUS_M) < 1,
        `cohort ${cohort.cohortIndex} must switch to upper flow at its mass-weighted release time`,
      );
    }
  });
}
