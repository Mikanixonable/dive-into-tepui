import * as assert from 'node:assert/strict';
import {
  sampleConvectiveCloudEvents,
  type CloudEventDomain,
  type ConvectiveCloudCell,
} from '../../src/game/cloud/cloud-events';
import { reconstructCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-transport';
import { norm, v3 } from '../../src/math/vec3';
import { test } from '../harness';

const EARTH_RADIUS_M = 6_371_000;

function domainAt(timeSeconds: number): CloudEventDomain {
  const cells: ConvectiveCloudCell[] = Array.from({ length: 2 }, (_, index) => ({
    id: `cold-cache-cell-${index}`,
    supplySourceId: `cold-cache-source-${index}`,
    convectivePotential: 1,
    upperRelativeHumidity: 0.85,
    liquidSupplyRateKgM2S: 1e-5,
    convectiveDurationSeconds: 1_200,
    sourcePosition: {
      directionUnitVector: norm(v3(1, 0.1 * index, 0.2 * index)),
      geometricHeightM: 1_000,
    },
    iceReleaseHeightM: 8_000,
  }));
  return {
    seed: 0x51e2,
    birthIntervalSeconds: 1_800,
    historyHorizonSeconds: 6 * 3_600,
    maximumOmittedMassKgM2: 1_000,
    maxEventCount: 10_000,
    timeSeconds,
    cells,
  };
}

function windAt(direction: ReturnType<typeof v3>) {
  const horizontalLength = Math.hypot(direction.x, direction.z);
  const east = horizontalLength > 1e-12
    ? v3(direction.z / horizontalLength, 0, -direction.x / horizontalLength)
    : v3(1, 0, 0);
  return {
    tangentVelocityMPerS: v3(east.x * 12, east.y * 12, east.z * 12),
    verticalVelocityMPerS: 0.02,
  };
}

function reconstructAt(timeSeconds: number) {
  const sample = sampleConvectiveCloudEvents(domainAt(timeSeconds));
  const material = sample.events.map((event) => reconstructCloudEventMaterialCohorts(
    event, EARTH_RADIUS_M, 600, windAt, 8,
  ));
  return { sample, material };
}

function measureSeekOrder(seekTimes: readonly number[]) {
  const startedAt = performance.now();
  const results = seekTimes.map(reconstructAt);
  const elapsedMilliseconds = performance.now() - startedAt;
  const returnedEventCount = results.reduce((count, result) => count + result.sample.events.length, 0);
  const transportWindSamples = results.reduce((count, result) => count + result.material.reduce(
    (eventSamples, material) => eventSamples
      + (material.parent?.steps ?? 0)
      + material.releasedIceCohorts.reduce((cohortSamples, cohort) => cohortSamples + cohort.steps, 0),
    0,
  ), 0);
  return { results, elapsedMilliseconds, returnedEventCount, transportWindSamples };
}

export function register(): void {
  test('cloud cold-cache measurement: product event and material cohorts replay identically across seek order', () => {
    const seekTimes = [7_200, 1_800, 10_800, 4_500];
    const forward = measureSeekOrder(seekTimes);
    const backward = measureSeekOrder([...seekTimes].reverse());
    const first = forward.results;
    const reverse = backward.results.reverse();
    assert.deepEqual(reverse, first);
    assert.equal(backward.returnedEventCount, forward.returnedEventCount);
    assert.equal(backward.transportWindSamples, forward.transportWindSamples);

    for (const { sample, material } of first) {
      assert.equal(material.length, sample.events.length);
      assert.ok(sample.events.length > 0);
      for (const [index, event] of sample.events.entries()) {
        const reconstructed = material[index]!;
        assert.ok(reconstructed.releasedIceCohorts.length <= 8);
        if (event.iceRelease.remainingKgM2 > 0) {
          assert.equal(reconstructed.releasedIceCohorts.length, 8);
        }
        assert.ok(reconstructed.totalMassKgM2 >= 0);
        assert.ok(Math.abs(
          reconstructed.totalMassKgM2 - event.mass.liquidKgM2 - event.mass.iceKgM2,
        ) < 1e-10);
      }
    }

    console.log(JSON.stringify({
      diagnostic: 'cloud-event-stateless-seek-reconstruction',
      cacheMisses: null,
      cacheNote: 'event and cohort reconstruction expose no cache to measure',
      evaluationsPerOrder: seekTimes.length,
      returnedEventsPerOrder: forward.returnedEventCount,
      transportWindSamplesPerOrder: forward.transportWindSamples,
      forwardElapsedMilliseconds: forward.elapsedMilliseconds,
      reverseElapsedMilliseconds: backward.elapsedMilliseconds,
    }));
  });
}
