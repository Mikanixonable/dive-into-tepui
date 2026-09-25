// Convective morphology/lifecycle diagnostics derived from immutable event inputs.
// The mass ledger remains in cloud-events.ts; this module only describes presentation state.

const SECONDS_PER_HOUR = 3_600;
const ANVIL_BASE_TAU_SECONDS = 2 * SECONDS_PER_HOUR;
const COLD_POOL_TAU_SECONDS = 90 * 60;
const MIN_ANVIL_ASPECT = 1.2;
const MAX_ANVIL_ASPECT = 2.4;

export type CloudLifecyclePhase =
  | 'developing' | 'mature' | 'anvil' | 'residual' | 'dissipating';

export interface CloudLifecycleInput {
  readonly eventId: string;
  readonly ageSeconds: number;
  readonly convectiveDurationSeconds: number;
  readonly upperRelativeHumidity: number;
}

export interface CloudLifecycleState {
  readonly phase: CloudLifecyclePhase;
  readonly updraftFraction: number;
  readonly anvilFraction: number;
  readonly residualIceFraction: number;
  readonly coldPoolFraction: number;
  readonly gustFrontTriggerFraction: number;
  readonly anvilAxisAngleRad: number;
  readonly anvilAspectRatio: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function hashUnit(text: string, salt: string): number {
  let hash = 0x811c9dc5;
  const value = `${salt}\0${text}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  return ((hash ^ (hash >>> 16)) >>> 0) / 0x1_0000_0000;
}

export function cloudLifecycleAt(input: CloudLifecycleInput): CloudLifecycleState {
  if (!input.eventId) throw new RangeError('eventId must not be empty');
  if (!Number.isFinite(input.ageSeconds) || input.ageSeconds < 0) {
    throw new RangeError('ageSeconds must be finite and non-negative');
  }
  if (!Number.isFinite(input.convectiveDurationSeconds) || input.convectiveDurationSeconds <= 0) {
    throw new RangeError('convectiveDurationSeconds must be finite and positive');
  }
  if (!Number.isFinite(input.upperRelativeHumidity)
    || input.upperRelativeHumidity < 0 || input.upperRelativeHumidity > 1) {
    throw new RangeError('upperRelativeHumidity must be between 0 and 1');
  }

  const age = input.ageSeconds;
  const duration = input.convectiveDurationSeconds;
  const growthDuration = Math.max(5 * 60, duration * 0.25);
  const updraftGrowth = smoothstep01(age / growthDuration);
  const updraftDecay = 1 - smoothstep01((age - duration * 0.72) / Math.max(duration * 0.28, 1));
  const updraftFraction = clamp01(updraftGrowth * updraftDecay);

  const dryMultiplier = 1 + (1 - input.upperRelativeHumidity) * 4;
  const anvilTauSeconds = ANVIL_BASE_TAU_SECONDS / dryMultiplier;
  const releaseStart = Math.min(15 * 60, duration * 0.5);
  const releaseProgress = smoothstep01((age - releaseStart) / Math.max(duration - releaseStart, 1));
  const tailAge = Math.max(age - duration, 0);
  const tailDecay = Math.exp(-tailAge / anvilTauSeconds);
  const anvilFraction = clamp01(releaseProgress * tailDecay);
  const residualIceFraction = age <= duration ? anvilFraction : tailDecay;

  const coldPoolBuild = smoothstep01((age - duration * 0.45) / Math.max(duration * 0.45, 1));
  const coldPoolTail = Math.exp(-Math.max(age - duration, 0) / COLD_POOL_TAU_SECONDS);
  const coldPoolFraction = clamp01(coldPoolBuild * coldPoolTail);
  const gustFrontTriggerFraction = clamp01(
    coldPoolFraction * (0.35 + 0.65 * input.upperRelativeHumidity),
  );

  const anvilAxisAngleRad = hashUnit(input.eventId, 'axis') * 2 * Math.PI;
  const anvilAspectRatio = MIN_ANVIL_ASPECT
    + hashUnit(input.eventId, 'aspect') * (MAX_ANVIL_ASPECT - MIN_ANVIL_ASPECT);

  let phase: CloudLifecyclePhase;
  if (age < growthDuration) phase = 'developing';
  else if (age < duration) phase = 'mature';
  else if (anvilFraction >= 0.5) phase = 'anvil';
  else if (residualIceFraction >= 0.08) phase = 'residual';
  else phase = 'dissipating';

  return Object.freeze({
    phase,
    updraftFraction,
    anvilFraction,
    residualIceFraction,
    coldPoolFraction,
    gustFrontTriggerFraction,
    anvilAxisAngleRad,
    anvilAspectRatio,
  });
}
