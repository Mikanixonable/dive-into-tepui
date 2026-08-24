/**
 * A small, deterministic sampler for the stationary Ornstein–Uhlenbeck
 * process used to render protein thermal motion.
 *
 * The process is sampled at a fixed rate.  `rmsAmplitude` is the stationary
 * standard deviation, rather than the standard deviation of one innovation.
 * Negative and non-finite sample times are clamped to zero by `sampleAt`.
 */

export interface ProteinBrownianModeParameters {
  readonly relaxationRate: number;
  readonly rmsAmplitude: number;
}

const UINT32_SCALE = 0x1_0000_0000;
const TWO_PI = Math.PI * 2;
const DEFAULT_SAMPLE_HZ = 30;
const DEFAULT_RELAXATION_RATE = 1;
const MAX_HISTORY = 16_384;
const TAIL_TOLERANCE = 1e-4;
// Keep ordinary forward display-time gaps cheap; larger jumps use a direct seek.
const MAX_SEQUENTIAL_CATCH_UP = 128;

/** Stable FNV-1a hash (over UTF-16 code units) for enemy identifiers. */
export function proteinBrownianSeedFor(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/** Counter-based hash.  Splitting the tick preserves high tick bits too. */
function counterHash(seed: number, mode: number, tick: number, lane: number): number {
  const low = tick >>> 0;
  const high = Math.floor(tick / UINT32_SCALE) >>> 0;
  let value = seed ^ Math.imul(mode + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b);
  value = mix32(value ^ low);
  return mix32(value ^ high ^ Math.imul(lane + 0x51, 0x27d4eb2d));
}

function gaussian(seed: number, mode: number, tick: number): number {
  // The half-unit offset prevents log(0) while retaining deterministic hashes.
  const first = (counterHash(seed, mode, tick, 0) + 0.5) / UINT32_SCALE;
  const second = (counterHash(seed, mode, tick, 1) + 0.5) / UINT32_SCALE;
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(TWO_PI * second);
}

function floorMod(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

interface SanitizedMode {
  readonly a: number;
  readonly innovationScale: number;
  readonly rmsAmplitude: number;
}

export class ProteinBrownianSampler {
  readonly modeCount: number;

  private readonly sampleHz: number;
  private readonly seed: number;
  private readonly modes: readonly SanitizedMode[];
  private readonly historyLength: number;
  private readonly tailFactors: Float64Array;
  private readonly history: Float64Array;
  private currentValues: Float64Array;
  private nextValues: Float64Array;
  private currentTick = -1;

  constructor(modes: readonly ProteinBrownianModeParameters[], sampleHz: number, seed: number) {
    this.modeCount = modes.length;
    this.sampleHz = Number.isFinite(sampleHz) && sampleHz > 0
      ? Math.min(Math.max(sampleHz, 1e-6), 1e6)
      : DEFAULT_SAMPLE_HZ;
    this.seed = Number.isFinite(seed) ? seed >>> 0 : 0;

    const sanitized: SanitizedMode[] = [];
    let longestHistory = 1;
    for (const mode of modes) {
      const relaxationRate = Number.isFinite(mode.relaxationRate) && mode.relaxationRate > 0
        ? mode.relaxationRate
        : DEFAULT_RELAXATION_RATE;
      const rmsAmplitude = Number.isFinite(mode.rmsAmplitude) && mode.rmsAmplitude >= 0
        ? Math.min(mode.rmsAmplitude, Number.MAX_VALUE / 16)
        : 0;
      const a = Math.exp(-relaxationRate / this.sampleHz);
      const innovationScale = rmsAmplitude * Math.sqrt(Math.max(0, 1 - a * a));
      sanitized.push({ a, innovationScale, rmsAmplitude });
      // a^m <= 1e-4 bounds the omitted stationary convolution tail.
      const required = a === 0 ? 1 : Math.ceil(Math.log(TAIL_TOLERANCE) / Math.log(a));
      longestHistory = Math.max(longestHistory, Math.min(MAX_HISTORY, required));
    }
    this.modes = sanitized;
    this.historyLength = longestHistory;
    this.tailFactors = new Float64Array(this.modeCount);
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      this.tailFactors[mode] = Math.pow(this.modes[mode]!.a, this.historyLength);
    }
    this.history = new Float64Array(this.modeCount * this.historyLength);
    this.currentValues = new Float64Array(this.modeCount);
    this.nextValues = new Float64Array(this.modeCount);
  }

  /** Returns the value at `time`, interpolated between fixed-rate samples. */
  sampleAt(time: number, out: Float64Array): Float64Array {
    if (out.length < this.modeCount) {
      throw new RangeError(`Protein Brownian output requires ${this.modeCount} values`);
    }
    const safeTime = Number.isFinite(time) && time > 0
      ? Math.min(time, Number.MAX_SAFE_INTEGER / this.sampleHz)
      : 0;
    const samplePosition = safeTime * this.sampleHz;
    const tick = Math.floor(samplePosition);
    const fraction = samplePosition - tick;

    if (this.currentTick < 0) {
      this.rebuild(tick);
    } else if (tick !== this.currentTick) {
      const gap = tick - this.currentTick;
      const catchUpLimit = Math.min(this.historyLength, MAX_SEQUENTIAL_CATCH_UP);
      if (gap > 0 && gap <= catchUpLimit) {
        for (let step = 0; step < gap; step += 1) this.advanceOne();
      } else {
        this.rebuild(tick);
      }
    }
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      const current = this.currentValues[mode]!;
      const next = this.nextValues[mode]!;
      out[mode] = current + (next - current) * fraction;
    }
    return out;
  }

  private innovation(mode: number, tick: number): number {
    return this.modes[mode]!.innovationScale * gaussian(this.seed, mode, tick);
  }

  private rebuild(tick: number): void {
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      const parameters = this.modes[mode]!;
      let value = 0;
      let power = 1;
      const offset = mode * this.historyLength;
      for (let age = 0; age < this.historyLength; age += 1) {
        const noiseTick = tick - 1 - age;
        const noise = this.innovation(mode, noiseTick);
        this.history[offset + floorMod(noiseTick, this.historyLength)] = noise;
        value += power * noise;
        power *= parameters.a;
      }
      this.currentValues[mode] = value;
      const noise = this.innovation(mode, tick);
      const oldNoise = this.history[offset + floorMod(tick - this.historyLength, this.historyLength)]!;
      this.nextValues[mode] = parameters.a * value + noise - this.tailFactors[mode]! * oldNoise;
      this.history[offset + floorMod(tick, this.historyLength)] = noise;
    }
    this.currentTick = tick;
  }

  private advanceOne(): void {
    const transitionTick = this.currentTick + 1;
    // `currentValues` is q_n and `nextValues` is the already cached q_(n+1).
    // Shift that pair first; the recycled buffer can then hold q_(n+2).
    const previous = this.currentValues;
    this.currentValues = this.nextValues;
    this.nextValues = previous;
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      const parameters = this.modes[mode]!;
      const offset = mode * this.historyLength;
      const oldIndex = offset + floorMod(transitionTick - this.historyLength, this.historyLength);
      const noise = this.innovation(mode, transitionTick);
      const oldNoise = this.history[oldIndex]!;
      this.nextValues[mode] = parameters.a * this.currentValues[mode]! + noise - this.tailFactors[mode]! * oldNoise;
      this.history[oldIndex] = noise;
    }
    this.currentTick = transitionTick;
  }
}
