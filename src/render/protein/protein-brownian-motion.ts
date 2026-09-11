/**
 * 表示用の熱揺らぎを表す定常 Ornstein–Uhlenbeck 過程を、seed と時刻から決定的に標本化する。
 */

interface ProteinBrownianModeParameters {
  /** 緩和率 [1/s]。 */
  readonly relaxationRate: number;
  /** 定常分布の標準偏差。1標本ごとの innovation の大きさはここから導く。 */
  readonly rmsAmplitude: number;
}

/** 32bit 整数を [0, 1) へ写す除数。 */
export const UINT32_SCALE = 0x1_0000_0000;
const TWO_PI = Math.PI * 2;
const DEFAULT_SAMPLE_HZ = 30;
const DEFAULT_RELAXATION_RATE = 1; // [1/s]
// 定常分布の再構成で遡る innovation の最大個数。
const MAX_HISTORY = 16_384;
// 再構成で打ち切る畳み込みの裾の寄与の上限。
const TAIL_TOLERANCE = 1e-4;
// 前進がこの標本数以内なら逐次に進め、超える飛びは履歴から組み直す。
const MAX_SEQUENTIAL_CATCH_UP = 128;

/** 敵 ID から、実行をまたいで変わらない 32bit seed を作る。 */
export function proteinBrownianSeedFor(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 32bit の値を、一様に近い32bit ハッシュへ混ぜ込む finalizer。 */
export function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/** seed・モード・tick・レーンで決まるハッシュ。2^32 標本を超えても別の値になるよう、tick は上位 32bit まで混ぜる。 */
function counterHash(seed: number, mode: number, tick: number, lane: number): number {
  const low = tick >>> 0;
  const high = Math.floor(tick / UINT32_SCALE) >>> 0;
  let value = seed ^ Math.imul(mode + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b);
  value = mix32(value ^ low);
  return mix32(value ^ high ^ Math.imul(lane + 0x51, 0x27d4eb2d));
}

// (seed, mode, tick) で決まる標準正規乱数(Box–Muller)。
function gaussian(seed: number, mode: number, tick: number): number {
  // 0.5 を足して log(0) を避ける。
  const first = (counterHash(seed, mode, tick, 0) + 0.5) / UINT32_SCALE;
  const second = (counterHash(seed, mode, tick, 1) + 0.5) / UINT32_SCALE;
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(TWO_PI * second);
}

// 負の value でも [0, modulus) に収まる剰余。
function floorMod(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

// 入力を既定値へ丸めたモード。
interface SanitizedMode {
  /** 1標本あたりの減衰係数。 */
  readonly a: number;
  readonly innovationScale: number;
  readonly rmsAmplitude: number;
}

export class ProteinBrownianSampler {
  private readonly modeCount: number;

  private readonly sampleHz: number;
  private readonly seed: number;
  private readonly modes: readonly SanitizedMode[];
  private readonly historyLength: number;
  // a^historyLength。窓から外れる innovation の寄与を差し引く係数。
  private readonly tailFactors: Float64Array;
  // モードごとの直近 historyLength 個の innovation。tick の剰余の位置に置く。
  private readonly history: Float64Array;
  // currentTick の標本の値と、その次の標本の値。
  private currentValues: Float64Array;
  private nextValues: Float64Array;
  private currentTick = -1;

  /** 同じ modes・sampleHz [Hz]・seed なら同じ標本列を返す。不正な値は既定値へ丸める。 */
  public constructor(modes: readonly ProteinBrownianModeParameters[], sampleHz: number, seed: number) {
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
      // 打ち切る裾 a^m が TAIL_TOLERANCE 以下になる長さを履歴に取る。
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

  /**
   * time [s] での各モードの値を out へ書いて返す。固定周波数の標本の間は線形補間し、負・非有限の
   * time は 0 とする。out が modeCount より短ければ例外を投げる。
   */
  public sampleAt(time: number, out: Float64Array): Float64Array {
    if (out.length < this.modeCount) {
      throw new RangeError(`Protein Brownian output requires ${this.modeCount} values`);
    }
    // 時刻を標本位置へ換算する。
    const safeTime = Number.isFinite(time) && time > 0
      ? Math.min(time, Number.MAX_SAFE_INTEGER / this.sampleHz)
      : 0;
    const samplePosition = safeTime * this.sampleHz;
    const tick = Math.floor(samplePosition);
    const fraction = samplePosition - tick;

    // 近い前進は逐次に進め、初回・後退・大きな飛びは組み直す。
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
    // 隣り合う標本の間を補間する。
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      const current = this.currentValues[mode]!;
      const next = this.nextValues[mode]!;
      out[mode] = current + (next - current) * fraction;
    }
    return out;
  }

  // tick 番目の innovation。seed・モード・tick で決まる。
  private innovation(mode: number, tick: number): number {
    return this.modes[mode]!.innovationScale * gaussian(this.seed, mode, tick);
  }

  // tick とその次の標本の値を、それまでの状態に依らず組み直す。
  private rebuild(tick: number): void {
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      const parameters = this.modes[mode]!;
      // 窓内の innovation を減衰させて足し合わせる。
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
      // 次の標本の値も用意する。
      const noise = this.innovation(mode, tick);
      const oldNoise = this.history[offset + floorMod(tick - this.historyLength, this.historyLength)]!;
      this.nextValues[mode] = parameters.a * value + noise - this.tailFactors[mode]! * oldNoise;
      this.history[offset + floorMod(tick, this.historyLength)] = noise;
    }
    this.currentTick = tick;
  }

  // 1標本進め、その次の標本の値を用意する。
  private advanceOne(): void {
    const transitionTick = this.currentTick + 1;
    const previous = this.currentValues;
    this.currentValues = this.nextValues;
    this.nextValues = previous;
    for (let mode = 0; mode < this.modeCount; mode += 1) {
      const parameters = this.modes[mode]!;
      const offset = mode * this.historyLength;
      const oldIndex = offset + floorMod(transitionTick - this.historyLength, this.historyLength);
      const noise = this.innovation(mode, transitionTick);
      const oldNoise = this.history[oldIndex]!;
      // 窓から外れる innovation を差し引くので、逐次に進めても rebuild と同じ値になる。
      this.nextValues[mode] = parameters.a * this.currentValues[mode]! + noise - this.tailFactors[mode]! * oldNoise;
      this.history[oldIndex] = noise;
    }
    this.currentTick = transitionTick;
  }
}
