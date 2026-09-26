// CPU cold-reconstruction benchmark for the bounded convective event/cohort path.
// This measures deterministic reconstruction only; rendering/GPU preparation is measured separately by render-lab.
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  sampleConvectiveCloudEvents,
  type CloudEventDomain,
  type ConvectiveCloudCell,
} from '../src/game/cloud/cloud-events';
import {
  reconstructCloudEventMaterialCohorts,
  type CloudEventWindAt,
} from '../src/game/cloud/cloud-event-transport';
import { v3 } from '../src/math/vec3';
import type { Vec3 } from '../src/math/vec3';

const EARTH_RADIUS_M = 6_371_000;
const MAX_STEP_SECONDS = 30;
const REPEATS = 7;

interface Scenario {
  readonly id: string;
  readonly cellCount: number;
  readonly timeSeconds: number;
  readonly cohortCount: number;
}

const SCENARIOS: readonly Scenario[] = [
  { id: 'standard-8-events-5min', cellCount: 8, timeSeconds: 7_200, cohortCount: 12 },
  { id: 'standard-32-events-5min', cellCount: 32, timeSeconds: 7_200, cohortCount: 12 },
  { id: 'jump-32-events-5min', cellCount: 32, timeSeconds: 14_400, cohortCount: 12 },
  { id: 'stress-32-events-1min', cellCount: 32, timeSeconds: 7_200, cohortCount: 60 },
  { id: 'stress-64-events-5min', cellCount: 64, timeSeconds: 7_200, cohortCount: 12 },
];

function eastAt(direction: Vec3): Vec3 {
  const horizontal = Math.hypot(direction.x, direction.z);
  return horizontal > 1e-12
    ? v3(direction.z / horizontal, 0, -direction.x / horizontal)
    : v3(1, 0, 0);
}

const windAt: CloudEventWindAt = (direction, heightM) => {
  const east = eastAt(direction);
  const speedMPerS = heightM >= 5_000 ? 22 : 12;
  return {
    tangentVelocityMPerS: v3(east.x * speedMPerS, east.y * speedMPerS, east.z * speedMPerS),
    verticalVelocityMPerS: 0,
  };
};

function cells(count: number): readonly ConvectiveCloudCell[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${index}`,
    supplySourceId: `benchmark-source-${index}`,
    convectivePotential: 1,
    upperRelativeHumidity: 0.7,
    liquidSupplyRateKgM2S: 1e-5,
    convectiveDurationSeconds: 3_600,
    sourcePosition: {
      directionUnitVector: v3(0, 0, 1),
      geometricHeightM: 1_000,
    },
    iceReleaseHeightM: 8_000,
  }));
}

function domainOf(scenario: Scenario): CloudEventDomain {
  return {
    seed: 11,
    birthIntervalSeconds: 86_400,
    historyHorizonSeconds: 86_400,
    maximumOmittedMassKgM2: 1_000,
    maxEventCount: scenario.cellCount,
    timeSeconds: scenario.timeSeconds,
    cells: cells(scenario.cellCount),
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function measure(scenario: Scenario) {
  const samplesMs: number[] = [];
  let eventCount = 0;
  let cohortCount = 0;
  let transportSteps = 0;
  let totalMassKgM2 = 0;

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const startedAt = performance.now();
    const sample = sampleConvectiveCloudEvents(domainOf(scenario));
    let runCohorts = 0;
    let runSteps = 0;
    let runMass = 0;
    for (const event of sample.events) {
      const reconstructed = reconstructCloudEventMaterialCohorts(
        event,
        EARTH_RADIUS_M,
        MAX_STEP_SECONDS,
        windAt,
        scenario.cohortCount,
      );
      runCohorts += reconstructed.releasedIceCohorts.length;
      runSteps += reconstructed.parent?.steps ?? 0;
      runSteps += reconstructed.releasedIceCohorts.reduce((sum, cohort) => sum + cohort.steps, 0);
      runMass += reconstructed.totalMassKgM2;
    }
    samplesMs.push(performance.now() - startedAt);
    eventCount = sample.events.length;
    cohortCount = runCohorts;
    transportSteps = runSteps;
    totalMassKgM2 = runMass;
  }

  return {
    ...scenario,
    repeats: REPEATS,
    eventCount,
    cohortCount,
    transportSteps,
    totalMassKgM2,
    ms: {
      min: Math.min(...samplesMs),
      median: percentile(samplesMs, 0.5),
      p95: percentile(samplesMs, 0.95),
      max: Math.max(...samplesMs),
      samples: samplesMs,
    },
  };
}

const results = SCENARIOS.map(measure);
const document = {
  recordedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  maxStepSeconds: MAX_STEP_SECONDS,
  results,
  interpretation:
    'Each sample rebuilds event history and all finite release cohorts from immutable inputs. '
    + 'The benchmark excludes rendering, file IO, and GPU work; use cloud-baseline.json for those paths.',
};
mkdirSync('.render-lab', { recursive: true });
writeFileSync('.render-lab/cloud-reconstruction-benchmark.json', `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify(document, null, 2));
