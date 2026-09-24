// render-lab の対計測分布と、観測済み render 時間の適格性を要約する。
const MODE_IDS = ['generated-standard', 'observed-standard'];
const REQUIRED_QUALIFICATION_BLOCKS = 8;
const OBSERVED_RENDER_INCREASE_LIMIT_MS = 3;

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

// 記録された表示装置が対象の Apple M4 Pro であることを確かめる。
function hasTargetHardware(hardware) {
  return hardware?.platform === 'darwin'
    && Array.isArray(hardware.systemGraphics)
    && hardware.systemGraphics.some((graphics) =>
      typeof graphics?.chipset === 'string' && /apple.*m4 pro/i.test(graphics.chipset));
}

// timestamp が有効な観測済み render 計測の p95 を返す。
function observedRenderP95(run) {
  const measurement = run?.measurement;
  const frames = measurement?.frames;
  const result = measurement?.observedRenderTotalMs;
  return measurement?.gpuSupported === true
    && Number.isInteger(frames) && frames > 0
    && measurement.observedRenderCompleteFrames === frames
    && result?.samples === frames
    && typeof result.p95 === 'number' && Number.isFinite(result.p95) && result.p95 > 0
    ? result.p95 : null;
}

// observed-render の計測区間に compute query が含まれていないことを確かめる。
function hasNoComputeQueries(run) {
  const measurement = run?.measurement;
  const counts = measurement?.observedComputeExpectedQueryCounts;
  return Array.isArray(counts)
    && counts.length === measurement.frames
    && counts.every((count) => Number.isInteger(count) && count === 0);
}

// 1 モードの paired p95 増分と off/off 再現誤差を判定する。
function modeQualification(blocks, modeId) {
  const deltas = [];
  const noise = [];
  for (const block of blocks) {
    const entry = block?.modes?.[modeId];
    const before = observedRenderP95(entry?.offBefore);
    const cloud = observedRenderP95(entry?.cloudOn);
    const after = observedRenderP95(entry?.offAfter);
    if (before === null || cloud === null || after === null) {
      return { status: 'indeterminate', reason: 'A measurement is unsupported, incomplete, or has no valid timestamp samples.' };
    }
    if (![entry.offBefore, entry.cloudOn, entry.offAfter].every(hasNoComputeQueries)) {
      return { status: 'indeterminate', reason: 'Compute queries were issued outside the observed-render scope.' };
    }
    deltas.push(cloud - (before + after) / 2);
    noise.push(Math.abs(after - before));
  }

  const pairedP95Delta = distribution(deltas);
  const repeatabilityNoise = distribution(noise);
  const uncertaintyIntervalMs = {
    lower: pairedP95Delta.p95 - repeatabilityNoise.p95,
    upper: pairedP95Delta.p95 + repeatabilityNoise.p95,
  };
  if (!(repeatabilityNoise.p95 < OBSERVED_RENDER_INCREASE_LIMIT_MS)) {
    return {
      status: 'indeterminate',
      reason: 'Off/off repeatability noise is not below the increase limit.',
      pairedObservedRenderP95DeltaMs: pairedP95Delta,
      offOffRepeatabilityNoiseFloorMs: repeatabilityNoise,
      uncertaintyIntervalMs,
    };
  }
  const status = uncertaintyIntervalMs.upper <= OBSERVED_RENDER_INCREASE_LIMIT_MS
    ? 'pass'
    : uncertaintyIntervalMs.lower > OBSERVED_RENDER_INCREASE_LIMIT_MS ? 'fail' : 'indeterminate';
  return {
    status,
    reason: status === 'pass'
      ? 'The paired observed-render p95 upper bound is within the increase limit.'
      : status === 'fail'
        ? 'The paired observed-render p95 lower bound exceeds the increase limit.'
        : 'The paired observed-render p95 uncertainty interval crosses the increase limit.',
    pairedObservedRenderP95DeltaMs: pairedP95Delta,
    offOffRepeatabilityNoiseFloorMs: repeatabilityNoise,
    uncertaintyIntervalMs,
  };
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

/** 雲ありの observed-render p95 増分を、指定ハードウェアと反復条件の下で判定する。 */
export function qualifyObservedRenderBaseline(blocks, hardware) {
  const fixtureMatches = hardware?.standardNearRange250kmFixture === true;
  const scope = fixtureMatches ? 'observed-render-total' : 'observed-render-engineering-diagnostic';
  const prerequisites = {
    targetHardware: 'Apple M4 Pro',
    standardNearRange250kmMediumFixture: true,
    requiredCompleteBlocks: REQUIRED_QUALIFICATION_BLOCKS,
    timestampQuery: true,
    appleMetalAdapterWithNoReportedFallback: true,
    pairedObservedRenderP95IncreaseLimitMs: OBSERVED_RENDER_INCREASE_LIMIT_MS,
    repeatabilityNoiseBelowMs: OBSERVED_RENDER_INCREASE_LIMIT_MS,
    uncertaintyIntervalUsesOffOffNoiseP95: true,
    computeQueryCountPerMeasurement: 0,
  };
  if (!hasTargetHardware(hardware)) {
    return { status: 'indeterminate', scope, prerequisites, reason: 'Target hardware was not identified as Apple M4 Pro.' };
  }
  if (hardware.timestampQueryAdvertised !== true) {
    return { status: 'indeterminate', scope, prerequisites, reason: 'Timestamp queries are not advertised by the adapter.' };
  }
  if (hardware.adapterFallback === true
    || hardware.adapterVendor !== 'apple'
    || typeof hardware.adapterArchitecture !== 'string'
    || !hardware.adapterArchitecture.startsWith('metal')) {
    return { status: 'indeterminate', scope, prerequisites, reason: 'The browser adapter must identify as an Apple Metal GPU and not report fallback.' };
  }
  if (!fixtureMatches) {
    return {
      status: 'indeterminate', scope, prerequisites,
      reason: 'The standard near-range 250 km fixture and medium quality preset are not selected.',
    };
  }
  if (!Array.isArray(blocks) || blocks.length !== REQUIRED_QUALIFICATION_BLOCKS) {
    return {
      status: 'indeterminate', scope, prerequisites,
      reason: `Exactly ${REQUIRED_QUALIFICATION_BLOCKS} complete blocks are required.`,
    };
  }

  const modes = Object.fromEntries(MODE_IDS.map((modeId) => [modeId, modeQualification(blocks, modeId)]));
  const statuses = Object.values(modes).map((entry) => entry.status);
  const status = statuses.includes('indeterminate')
    ? 'indeterminate'
    : statuses.includes('fail') ? 'fail' : 'pass';
  return {
    status,
    scope,
    prerequisites,
    modes,
    reason: status === 'pass'
      ? 'Both cloud sources meet the observed-render increase and repeatability limits.'
      : status === 'fail'
        ? 'At least one cloud source exceeds the observed-render increase limit.'
        : 'At least one required measurement or repeatability prerequisite is indeterminate.',
  };
}
