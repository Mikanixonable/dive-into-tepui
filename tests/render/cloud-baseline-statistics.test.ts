import * as assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from '../harness';

interface BaselineStatistics {
  summarizeBaselineBlocks(blocks: readonly unknown[]): {
    readonly scope: string;
    readonly modes: Record<string, {
      readonly pairedInstrumentedPassP95DeltaMs: { readonly avg: number; readonly p50: number; readonly p95: number };
      readonly offOffRepeatabilityNoiseFloorMs: { readonly avg: number; readonly p50: number; readonly p95: number };
    }>;
  };
  qualifyObservedRenderBaseline(blocks: readonly unknown[], hardware: unknown): {
    readonly status: string;
    readonly scope: string;
    readonly prerequisites: {
      readonly requiredCompleteBlocks: number;
      readonly pairedObservedRenderP95IncreaseLimitMs: number;
      readonly repeatabilityNoiseBelowMs: number;
      readonly computeQueryCountPerMeasurement: number;
    };
    readonly modes?: Record<string, {
      readonly status: string;
      readonly pairedObservedRenderP95DeltaMs?: { readonly p95: number };
      readonly offOffRepeatabilityNoiseFloorMs?: { readonly p95: number };
      readonly uncertaintyIntervalMs?: { readonly lower: number; readonly upper: number };
    }>;
  };
}

const importModule = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<BaselineStatistics>;

// 30 フレームすべての timestamp が解決した測定を作る。
function run(p95: number, observedP95 = p95) {
  return { measurement: {
    gpuPassTotalMs: { p95 },
    gpuSupported: true,
    frames: 30,
    observedRenderTotalSamplesMs: Array.from({ length: 30 }, () => observedP95),
    observedRenderExpectedQueryCounts: Array.from({ length: 30 }, () => 1),
    observedRenderResolvedQueryCounts: Array.from({ length: 30 }, () => 1),
    observedComputeExpectedQueryCounts: Array.from({ length: 30 }, () => 0),
    observedRenderCompleteFrames: 30,
    observedRenderTotalMs: { p95: observedP95 },
  } };
}

// 雲ありを前後の雲なし測定で挟む一組を作る。
function mode(before: number, cloud: number, after: number) {
  return { offBefore: run(before), cloudOn: run(cloud), offAfter: run(after) };
}

// 両系統へ指定した増分と off/off 差を持つ8ブロックを作る。
function qualificationBlocks(deltas: { generated: number; observed: number }, noise = 0.5) {
  return Array.from({ length: 8 }, () => ({ modes: {
    'generated-standard': mode(10 - noise / 2, 10 + deltas.generated, 10 + noise / 2),
    'observed-standard': mode(10 - noise / 2, 10 + deltas.observed, 10 + noise / 2),
  } }));
}

const qualificationHardware = {
  platform: 'darwin',
  systemGraphics: [{ chipset: 'Apple M4 Pro' }],
  timestampQueryAdvertised: true,
  adapterFallback: false,
  adapterVendor: 'apple',
  adapterArchitecture: 'metal-3',
  standardNearRange250kmFixture: true,
};

// 浮動小数点の丸めを許して境界値を照合する。
function assertNear(actual: number | null, expected: number) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9);
}

// 集計値と、適格性を欠く測定の保留条件を検査する。
export function register(): void {
  // 記述統計の入力欠損と反復集約を検査する。
  test('cloud baseline statistics: paired p95 delta and off/off noise are separate exact distributions', async () => {
    const { summarizeBaselineBlocks } = await importModule(pathToFileURL(
      resolve(process.cwd(), 'tools/cloud-baseline-statistics.mjs'),
    ).href);
    const result = summarizeBaselineBlocks([
      { modes: {
        'generated-standard': mode(10, 20, 14),
        'observed-standard': mode(4, 9, 6),
      } },
      { modes: {
        'generated-standard': mode(8, 15, 10),
        'observed-standard': mode(5, 11, 5),
      } },
    ]);

    assert.equal(result.scope, 'instrumented-render-pass-sum');
    assert.deepEqual(result.modes['generated-standard']?.pairedInstrumentedPassP95DeltaMs, {
      samples: 2, avg: 7, p50: 6, p95: 8, min: 6, max: 8,
    });
    assert.deepEqual(result.modes['generated-standard']?.offOffRepeatabilityNoiseFloorMs, {
      samples: 2, avg: 3, p50: 2, p95: 4, min: 2, max: 4,
    });
    assert.deepEqual(result.modes['observed-standard']?.pairedInstrumentedPassP95DeltaMs, {
      samples: 2, avg: 5, p50: 4, p95: 6, min: 4, max: 6,
    });
    assert.deepEqual(result.modes['observed-standard']?.offOffRepeatabilityNoiseFloorMs, {
      samples: 2, avg: 1, p50: 0, p95: 2, min: 0, max: 2,
    });
  });

  test('cloud baseline statistics: empty blocks and missing samples are rejected', async () => {
    const { summarizeBaselineBlocks } = await importModule(pathToFileURL(
      resolve(process.cwd(), 'tools/cloud-baseline-statistics.mjs'),
    ).href);
    assert.throws(() => summarizeBaselineBlocks([]), /At least one baseline block/);
    assert.throws(() => summarizeBaselineBlocks([{ modes: {} }]), /Missing finite instrumented-pass p95/);
  });

  // 判定の閾値・ノイズ・測定範囲を独立に検査する。
  test('cloud baseline qualification: paired observed-render p95 deltas pass within the limit', async () => {
    const { qualifyObservedRenderBaseline } = await importModule(pathToFileURL(
      resolve(process.cwd(), 'tools/cloud-baseline-statistics.mjs'),
    ).href);
    const result = qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 2.5, observed: 1.5 }),
      qualificationHardware,
    );

    assert.equal(result.scope, 'observed-render-total');
    assert.equal(result.status, 'pass');
    assert.equal(result.prerequisites.requiredCompleteBlocks, 8);
    assert.equal(result.prerequisites.pairedObservedRenderP95IncreaseLimitMs, 3);
    assert.equal(result.prerequisites.repeatabilityNoiseBelowMs, 3);
    assert.equal(result.prerequisites.computeQueryCountPerMeasurement, 0);
    assert.equal(result.modes?.['generated-standard']?.pairedObservedRenderP95DeltaMs?.p95, 2.5);
    assert.deepEqual(result.modes?.['generated-standard']?.uncertaintyIntervalMs, { lower: 2.0, upper: 3 });
  });

  test('cloud baseline qualification: a measured increase above the limit fails', async () => {
    const { qualifyObservedRenderBaseline } = await importModule(pathToFileURL(
      resolve(process.cwd(), 'tools/cloud-baseline-statistics.mjs'),
    ).href);
    const result = qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 3.6, observed: 1.5 }),
      qualificationHardware,
    );

    assert.equal(result.status, 'fail');
    assert.equal(result.modes?.['generated-standard']?.status, 'fail');
    assertNear(result.modes?.['generated-standard']?.uncertaintyIntervalMs?.lower ?? null, 3.1);
    assertNear(result.modes?.['generated-standard']?.uncertaintyIntervalMs?.upper ?? null, 4.1);
  });

  test('cloud baseline qualification: an uncertainty interval that crosses the limit is indeterminate', async () => {
    const { qualifyObservedRenderBaseline } = await importModule(pathToFileURL(
      resolve(process.cwd(), 'tools/cloud-baseline-statistics.mjs'),
    ).href);
    const result = qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 3, observed: 1.5 }),
      qualificationHardware,
    );

    assert.equal(result.status, 'indeterminate');
    assertNear(result.modes?.['generated-standard']?.uncertaintyIntervalMs?.lower ?? null, 2.5);
    assertNear(result.modes?.['generated-standard']?.uncertaintyIntervalMs?.upper ?? null, 3.5);
  });

  test('cloud baseline qualification: incomplete timestamps or noisy repeats are indeterminate', async () => {
    const { qualifyObservedRenderBaseline } = await importModule(pathToFileURL(
      resolve(process.cwd(), 'tools/cloud-baseline-statistics.mjs'),
    ).href);
    const incomplete = qualificationBlocks({ generated: 1, observed: 1 });
    const run = incomplete[0]?.modes['generated-standard']?.cloudOn.measurement;
    if (run) run.observedRenderCompleteFrames = 29;
    const unsupported = qualificationBlocks({ generated: 1, observed: 1 });
    const unsupportedRun = unsupported[0]?.modes['observed-standard']?.offBefore.measurement;
    if (unsupportedRun) unsupportedRun.gpuSupported = false;
    const withCompute = qualificationBlocks({ generated: 1, observed: 1 });
    const computedRun = withCompute[0]?.modes['generated-standard']?.cloudOn.measurement;
    if (computedRun) computedRun.observedComputeExpectedQueryCounts[4] = 1;
    const incompleteResult = qualifyObservedRenderBaseline(incomplete, qualificationHardware);
    const mismatchedQueryCounts = qualificationBlocks({ generated: 1, observed: 1 });
    const mismatchedRun = mismatchedQueryCounts[0]?.modes['generated-standard']?.cloudOn.measurement;
    if (mismatchedRun) mismatchedRun.observedRenderResolvedQueryCounts[4] = 0;
    const mismatchedResult = qualifyObservedRenderBaseline(mismatchedQueryCounts, qualificationHardware);
    const unsupportedResult = qualifyObservedRenderBaseline(unsupported, qualificationHardware);
    const computeResult = qualifyObservedRenderBaseline(withCompute, qualificationHardware);
    const noisyResult = qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }, 3),
      qualificationHardware,
    );

    assert.equal(incompleteResult.status, 'indeterminate');
    assert.equal(mismatchedResult.status, 'indeterminate');
    assert.equal(unsupportedResult.status, 'indeterminate');
    assert.equal(computeResult.status, 'indeterminate');
    assert.equal(noisyResult.status, 'indeterminate');
    assert.equal(qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }).slice(0, 7),
      qualificationHardware,
    ).status, 'indeterminate');
    assert.equal(qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }),
      { ...qualificationHardware, systemGraphics: [{ chipset: 'Apple M4 Max' }] },
    ).status, 'indeterminate');
    assert.equal(qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }),
      { ...qualificationHardware, adapterFallback: true },
    ).status, 'indeterminate');
    assert.equal(qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }),
      { ...qualificationHardware, adapterVendor: 'google', adapterFallback: undefined },
    ).status, 'indeterminate');
    assert.equal(qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }),
      { ...qualificationHardware, adapterArchitecture: undefined, adapterFallback: undefined },
    ).status, 'indeterminate');
    assert.equal(qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }),
      { ...qualificationHardware, adapterFallback: undefined },
    ).status, 'pass');
    const diagnostic = qualifyObservedRenderBaseline(
      qualificationBlocks({ generated: 1, observed: 1 }),
      { ...qualificationHardware, standardNearRange250kmFixture: false },
    );
    assert.equal(diagnostic.scope, 'observed-render-engineering-diagnostic');
    assert.equal(diagnostic.status, 'indeterminate');
  });
}
