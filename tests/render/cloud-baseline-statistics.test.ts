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
}

const importModule = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<BaselineStatistics>;

function run(p95: number) {
  return { measurement: { gpuPassTotalMs: { p95 } } };
}

function mode(before: number, cloud: number, after: number) {
  return { offBefore: run(before), cloudOn: run(cloud), offAfter: run(after) };
}

export function register(): void {
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
}
