// 製品側の雲イベント・物質コホート再構成を CPU 上で計測する。
// GPU 時間や合否閾値は扱わない。
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = path.resolve(import.meta.dirname, '..');
const compile = spawnSync(process.execPath, [
  path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json',
], { cwd: root, encoding: 'utf8' });
if (compile.status !== 0) {
  process.stderr.write(compile.stdout);
  process.stderr.write(compile.stderr);
  process.exit(compile.status ?? 1);
}

const require = createRequire(import.meta.url);
const { sampleConvectiveCloudEvents } = require('../tests/dist/src/game/cloud/cloud-events.js');
const { reconstructCloudEventMaterialCohorts } = require(
  '../tests/dist/src/game/cloud/cloud-event-transport.js',
);
const { v3 } = require('../tests/dist/src/math/vec3.js');

const EARTH_RADIUS_M = 6_371_000;
const COHORT_COUNT = 8;
const MAX_STEP_SECONDS = 600;
const CASES = [
  { name: 'small', cellCount: 1, intervalSeconds: 1_800, horizonSeconds: 6 * 3_600, timeSeconds: 8 * 3_600 },
  { name: 'medium', cellCount: 4, intervalSeconds: 1_800, horizonSeconds: 24 * 3_600, timeSeconds: 30 * 3_600 },
  { name: 'large', cellCount: 8, intervalSeconds: 3_600, horizonSeconds: 48 * 3_600, timeSeconds: 60 * 3_600 },
];

function cellsOf(count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963229728653;
    const normalization = Math.hypot(Math.cos(angle), 0.25 * Math.sin(angle), Math.sin(angle));
    return {
      id: `benchmark-cell-${String(index).padStart(3, '0')}`,
      supplySourceId: `benchmark-source-${String(index).padStart(3, '0')}`,
      convectivePotential: 1,
      upperRelativeHumidity: 0.85,
      liquidSupplyRateKgM2S: 1e-5,
      convectiveDurationSeconds: 1_200,
      sourcePosition: {
        directionUnitVector: v3(
          Math.cos(angle) / normalization,
          0.25 * Math.sin(angle) / normalization,
          Math.sin(angle) / normalization,
        ),
        geometricHeightM: 1_000,
      },
      iceReleaseHeightM: 8_000,
    };
  });
}

function windAt(direction) {
  const horizontalLength = Math.hypot(direction.x, direction.z);
  const east = horizontalLength > 1e-12
    ? v3(direction.z / horizontalLength, 0, -direction.x / horizontalLength)
    : v3(1, 0, 0);
  const north = horizontalLength > 1e-12
    ? v3(-direction.x * direction.y, horizontalLength ** 2, -direction.z * direction.y)
    : v3(0, 0, 1);
  const northLength = Math.hypot(north.x, north.y, north.z);
  return {
    tangentVelocityMPerS: v3(
      east.x * 12 + north.x / northLength * 3,
      east.y * 12 + north.y / northLength * 3,
      east.z * 12 + north.z / northLength * 3,
    ),
    verticalVelocityMPerS: 0.02,
  };
}

function domainFor(fixture, timeSeconds) {
  return {
    seed: 0x51e2,
    birthIntervalSeconds: fixture.intervalSeconds,
    historyHorizonSeconds: fixture.horizonSeconds,
    maximumOmittedMassKgM2: 1_000,
    maxEventCount: 100_000,
    timeSeconds,
    cells: fixture.cells,
  };
}

function reconstruct(fixture, timeSeconds) {
  const sample = sampleConvectiveCloudEvents(domainFor(fixture, timeSeconds));
  let reconstructedEvents = 0;
  let reconstructedCohorts = 0;
  let reconstructedSteps = 0;
  let totalMassKgM2 = 0;
  for (const event of sample.events) {
    const result = reconstructCloudEventMaterialCohorts(
      event, EARTH_RADIUS_M, MAX_STEP_SECONDS, windAt, COHORT_COUNT,
    );
    reconstructedEvents += 1;
    reconstructedCohorts += result.releasedIceCohorts.length;
    totalMassKgM2 += result.totalMassKgM2;
    reconstructedSteps += (result.parent?.steps ?? 0);
    for (const cohort of result.releasedIceCohorts) reconstructedSteps += cohort.steps;
  }
  return {
    candidateEvents: fixture.cells.length
      * (Math.floor(timeSeconds / fixture.intervalSeconds)
        - Math.ceil((timeSeconds - fixture.horizonSeconds) / fixture.intervalSeconds) + 1),
    sampledEvents: sample.events.length,
    reconstructedEvents,
    reconstructedCohorts,
    reconstructedSteps,
    totalMassKgM2,
    truncatedEventCount: sample.truncatedEventCount,
    omittedMassUpperBoundKgM2: sample.omittedMassUpperBoundKgM2,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function measure(fixture, timeSeconds) {
  if (globalThis.gc) globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = reconstruct(fixture, timeSeconds);
  const elapsedMs = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  return { ...result, elapsedMs, heapDeltaBytes: heapAfter - heapBefore };
}

function runFixture(definition) {
  const fixture = { ...definition, cells: cellsOf(definition.cellCount) };
  const initial = measure(fixture, fixture.timeSeconds - fixture.horizonSeconds);
  // 初回とは異なる時刻を、結果キャッシュのない製品 API から問い合わせる。
  const cold = measure(fixture, fixture.timeSeconds);
  const repeatCount = 12;
  const repeated = Array.from({ length: repeatCount }, () => measure(fixture, fixture.timeSeconds));
  let randomState = 0x6d2b79f5;
  const randomSeekCount = 16;
  const randomSeeks = Array.from({ length: randomSeekCount }, () => {
    randomState = (Math.imul(randomState ^ (randomState >>> 15), 1 | randomState) + 0x6d2b79f5) | 0;
    randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), 61 | randomState);
    const unit = ((randomState ^ (randomState >>> 14)) >>> 0) / 0x1_0000_0000;
    const timeSeconds = fixture.timeSeconds - unit * fixture.horizonSeconds;
    return measure(fixture, timeSeconds);
  });
  const times = (samples) => samples.map((sample) => sample.elapsedMs);
  return {
    case: definition.name,
    configuration: {
      cells: definition.cellCount,
      historyHorizonSeconds: definition.horizonSeconds,
      birthIntervalSeconds: definition.intervalSeconds,
      targetTimeSeconds: definition.timeSeconds,
      cohortCountPerEvent: COHORT_COUNT,
      maxTransportStepSeconds: MAX_STEP_SECONDS,
    },
    sampleCounts: {
      initial: 1,
      cold: 1,
      repeated: repeated.length,
      randomSeek: randomSeeks.length,
    },
    workload: {
      candidateEvents: cold.candidateEvents,
      sampledEventsAtTarget: cold.sampledEvents,
      reconstructedEventsAtTarget: cold.reconstructedEvents,
      reconstructedCohortsAtTarget: cold.reconstructedCohorts,
      transportStepsAtTarget: cold.reconstructedSteps,
      truncatedEventsAtTarget: cold.truncatedEventCount,
      omittedMassUpperBoundKgM2: cold.omittedMassUpperBoundKgM2,
    },
    timingMs: {
      initial: initial.elapsedMs,
      cold: cold.elapsedMs,
      repeatedMedian: median(times(repeated)),
      repeatedP95: percentile(times(repeated), 0.95),
      randomSeekMedian: median(times(randomSeeks)),
      randomSeekP95: percentile(times(randomSeeks), 0.95),
    },
    heapDeltaBytes: {
      initial: initial.heapDeltaBytes,
      cold: cold.heapDeltaBytes,
      repeatedMedian: median(repeated.map((sample) => sample.heapDeltaBytes)),
      randomSeekMedian: median(randomSeeks.map((sample) => sample.heapDeltaBytes)),
      interpretation: globalThis.gc
        ? 'heap used after optional GC before versus immediately after; not total allocated bytes'
        : 'heap used before versus immediately after; includes GC/JIT noise and is not total allocated bytes',
    },
  };
}

const report = {
  measurement: 'CPU-only deterministic cloud event and material-cohort reconstruction',
  scope: 'sampleConvectiveCloudEvents + reconstructCloudEventMaterialCohorts; no renderer, GPU, transfer, or image timing',
  runtime: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: os.cpus().length,
    gcExposed: Boolean(globalThis.gc),
    gpuTime: 'not measured',
  },
  cases: CASES.map(runFixture),
};
console.log(JSON.stringify(report, null, 2));
