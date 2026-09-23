// 反復した対計測の分布を、合否閾値を設けず要約する。
const MODE_IDS = ['generated-standard', 'observed-standard'];

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function p95(run, blockIndex, modeId, runId) {
  const value = run?.measurement?.gpuPassTotalMs?.p95;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Missing finite instrumented-pass p95 for block ${blockIndex}, ${modeId}/${runId}`);
  }
  return value;
}

/** 雲ありと前後の雲なし計測から差分と反復誤差の分布を返す。 */
export function summarizeBaselineBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new RangeError('At least one baseline block is required');
  }
  const modes = {};
  for (const modeId of MODE_IDS) {
    const deltas = [];
    const noise = [];
    for (const [blockIndex, block] of blocks.entries()) {
      const entry = block?.modes?.[modeId];
      const before = p95(entry?.offBefore, blockIndex, modeId, 'offBefore');
      const cloud = p95(entry?.cloudOn, blockIndex, modeId, 'cloudOn');
      const after = p95(entry?.offAfter, blockIndex, modeId, 'offAfter');
      deltas.push(cloud - (before + after) / 2);
      noise.push(Math.abs(after - before));
    }
    modes[modeId] = {
      pairedInstrumentedPassP95DeltaMs: distribution(deltas),
      offOffRepeatabilityNoiseFloorMs: distribution(noise),
    };
  }
  return {
    scope: 'instrumented-render-pass-sum',
    pairedDeltaDefinition: 'cloud-on measurement p95 minus the mean of the same block\'s surrounding cloud-off p95 values',
    noiseFloorDefinition: 'absolute difference between the same block\'s surrounding cloud-off p95 values',
    modes,
  };
}
