import {
  ProteinBrownianSampler,
  proteinBrownianSeedFor,
} from './protein-brownian-motion';
import type { ProteinMotionAsset, ProteinPhase } from './protein-schema';

type ProteinMotionBand = ProteinMotionAsset['modes'][number]['band'];

export type ProteinMotionLod = 'near' | 'medium' | 'far' | 'marker';

export const PROTEIN_MOTION_LOD_MODE_COUNTS: Readonly<Record<ProteinMotionLod, number>> = {
  near: 24,
  medium: 12,
  far: 4,
  marker: 0,
};

/** Display-only phase gains; physical ANM amplitudes remain unchanged. */
export const PROTEIN_MOTION_PHASE_GAINS: Readonly<Record<ProteinPhase, number>> = {
  intact: 1,
  exposed: 1,
  dissociated: 1,
  critical: 1.5,
};

// LOD ごとの最小投影直径 [px]。並びは細かい方から粗い方(near→marker)。
const LODS_FINE_TO_COARSE: readonly ProteinMotionLod[] = ['near', 'medium', 'far', 'marker'];
const LOD_MIN_PROJECTED_PX: Readonly<Record<ProteinMotionLod, number>> = {
  near: 160, medium: 40, far: 8, marker: 0,
};
// 閾値ちょうどで毎フレーム LOD が往復しないための不感帯。
const LOD_HYSTERESIS_RATIO = 0.15;

/**
 * 画面投影直径 [px] から次の LOD を選ぶ。`previous` を跨いだヒステリシスを掛けるため、
 * より細かい LOD へ上げるには自身の閾値を +15% 上回る必要があり、より粗い LOD へ下げるには
 * 現在の LOD の閾値を -15% 下回る必要がある。大きな距離の飛び(seek 直後など)では複数段
 * まとめて遷移する。
 */
export function proteinMotionLodForProjectedSize(diameterPx: number, previous: ProteinMotionLod): ProteinMotionLod {
  // NaN は 0(marker側)へ、+Infinity(視点が無く LOD を判断できない呼び出し)は近距離側へ倒す。
  const safeDiameter = diameterPx >= 0 ? diameterPx : 0;
  let index = LODS_FINE_TO_COARSE.indexOf(previous);
  if (index < 0) index = 0;
  for (;;) {
    const currentMin = LOD_MIN_PROJECTED_PX[LODS_FINE_TO_COARSE[index]!];
    if (index < LODS_FINE_TO_COARSE.length - 1 && safeDiameter < currentMin * (1 - LOD_HYSTERESIS_RATIO)) {
      index += 1;
      continue;
    }
    if (index > 0) {
      const finerMin = LOD_MIN_PROJECTED_PX[LODS_FINE_TO_COARSE[index - 1]!];
      if (safeDiameter >= finerMin * (1 + LOD_HYSTERESIS_RATIO)) {
        index -= 1;
        continue;
      }
    }
    return LODS_FINE_TO_COARSE[index]!;
  }
}

const MAX_MOTION_MODES = PROTEIN_MOTION_LOD_MODE_COUNTS.near;
const MEDIUM_UPDATE_HZ = 30;
const FAR_UPDATE_HZ = 15;
const UINT32_SCALE = 0x1_0000_0000;
/** LOD 切替時、旧 LOD の変位から新 LOD の変位へ表示上ブレンドする時間 [s]。 */
export const PROTEIN_MOTION_LOD_FADE_DURATION_SEC = 0.25;

export interface ProteinMotionControllerOptions {
  /** Optional display-only overrides; physical modal amplitudes remain asset data. */
  readonly collectiveGain?: number;
  readonly localGain?: number;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/** Stable [0, 1) phase used to stagger coarse LOD update boundaries. */
export function proteinMotionUpdatePhaseFor(enemyId: string): number {
  const seed = proteinBrownianSeedFor(enemyId);
  return mix32(seed ^ 0xa511e9b3) / UINT32_SCALE;
}

function safeDisplayTime(time: number): number {
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.min(time, Number.MAX_SAFE_INTEGER / 1_000_000);
}

function updateHzFor(lod: ProteinMotionLod): number {
  switch (lod) {
    case 'medium': return MEDIUM_UPDATE_HZ;
    case 'far': return FAR_UPDATE_HZ;
    case 'near': return Number.POSITIVE_INFINITY;
    case 'marker': return 0;
  }
}

function modeCountFor(lod: ProteinMotionLod, availableModes: number): number {
  return Math.min(PROTEIN_MOTION_LOD_MODE_COUNTS[lod], availableModes);
}

function gainForBand(
  band: ProteinMotionBand,
  collectiveGain: number,
  localGain: number,
): number {
  return band === 'collective' ? collectiveGain : localGain;
}

/**
 * Samples modal OU coefficients and projects them into a reusable residue
 * displacement buffer. It deliberately knows nothing about Three.js or the
 * eventual atom/ribbon/surface bindings.
 */
export class ProteinMotionController {
  readonly enemyId: string;
  readonly residueCount: number;
  readonly modeCount: number;
  readonly updatePhase: number;
  readonly collectiveGain: number;
  readonly localGain: number;

  private readonly modes: readonly ProteinMotionAsset['modes'][number][];
  private readonly sampler: ProteinBrownianSampler;
  private readonly modeCoefficientsBuffer: Float64Array;
  private readonly effectiveCoefficientsBuffer: Float32Array;
  private readonly residueOffsetsBuffer: Float32Array;
  private readonly rawTargetBuffer: Float32Array;
  private readonly fadeFromBuffer: Float32Array;
  private readonly modeGains: Float64Array;
  private currentLod: ProteinMotionLod = 'near';
  private currentModeCount = 0;
  private lastRawSampleTime = Number.NaN;
  private lastSampleTime = Number.NaN;
  private currentPhase: ProteinPhase = 'intact';
  private fading = false;
  private fadeStartTime = 0;

  constructor(
    asset: ProteinMotionAsset,
    enemyId: string,
    options: ProteinMotionControllerOptions = {},
  ) {
    if (!Number.isInteger(asset.residueCount) || asset.residueCount < 0) {
      throw new RangeError('Protein motion residueCount must be a non-negative integer');
    }
    if (asset.modes.length > MAX_MOTION_MODES) {
      throw new RangeError(`Protein motion supports at most ${MAX_MOTION_MODES} modes`);
    }

    this.enemyId = enemyId;
    this.residueCount = asset.residueCount;
    this.modeCount = asset.modes.length;
    this.currentModeCount = Math.min(MAX_MOTION_MODES, this.modeCount);
    this.modes = asset.modes;
    this.updatePhase = proteinMotionUpdatePhaseFor(enemyId);
    this.collectiveGain = finiteNonNegative(options.collectiveGain, finiteNonNegative(asset.display.collectiveGain, 1));
    this.localGain = finiteNonNegative(options.localGain, finiteNonNegative(asset.display.localGain, 1));
    this.sampler = new ProteinBrownianSampler(
      this.modes.map((mode) => ({
        relaxationRate: mode.displayRelaxationRate,
        rmsAmplitude: mode.physicalRmsAngstrom ?? mode.displayRmsAngstrom!,
      })),
      asset.display.sampleHz,
      proteinBrownianSeedFor(enemyId),
    );
    this.modeCoefficientsBuffer = new Float64Array(this.modeCount);
    this.effectiveCoefficientsBuffer = new Float32Array(this.modeCount);
    this.residueOffsetsBuffer = new Float32Array(this.residueCount * 4);
    this.rawTargetBuffer = new Float32Array(this.residueCount * 4);
    this.fadeFromBuffer = new Float32Array(this.residueCount * 4);
    this.modeGains = new Float64Array(this.modeCount);
    for (let modeIndex = 0; modeIndex < this.modeCount; modeIndex += 1) {
      const mode = this.modes[modeIndex]!;
      this.modeGains[modeIndex] = gainForBand(mode.band, this.collectiveGain, this.localGain);
    }
  }

  /** The coefficient buffer is stable for the lifetime of this controller. */
  get modeCoefficients(): Float64Array {
    return this.modeCoefficientsBuffer;
  }

  /** The xyz displacement plus reserved w buffer is stable for every update. */
  get residueOffsets(): Float32Array {
    return this.residueOffsetsBuffer;
  }

  /**
   * Per-mode coefficients with gain, phase gain, and LOD mode-count
   * truncation already folded in (zero past the active mode count) — the
   * same values `computeRawInto` projects into `residueOffsets`. A GPU
   * compute pass can multiply these against the asset's mode displacements
   * to reproduce the same raw projection.
   */
  get effectiveModeCoefficients(): Float32Array {
    return this.effectiveCoefficientsBuffer;
  }

  get activeModeCount(): number {
    return this.currentModeCount;
  }

  /** Quantized display time represented by the reusable residue buffer. */
  get sampleTime(): number {
    return this.lastSampleTime;
  }

  /**
   * Update at a display time and return the same residue buffer each time.
   * `sampleAt` and `seek` are aliases so callers can describe their intent
   * without changing the deterministic sampling semantics. A LOD change
   * blends from the previously returned buffer into the new target over
   * `PROTEIN_MOTION_LOD_FADE_DURATION_SEC` of display time instead of
   * popping, so callers may keep calling `update` every frame through a
   * LOD transition without special-casing it.
   */
  update(
    time: number,
    lod: ProteinMotionLod = 'near',
    phase: ProteinPhase = this.currentPhase,
  ): Float32Array {
    const output = this.residueOffsetsBuffer;
    const nextModeCount = modeCountFor(lod, this.modeCount);
    const rawSampleTime = nextModeCount === 0 ? 0 : this.sampleTimeFor(time, lod);
    const safeTime = safeDisplayTime(time);
    const inputsChanged = lod !== this.currentLod || nextModeCount !== this.currentModeCount
      || rawSampleTime !== this.lastRawSampleTime || phase !== this.currentPhase;

    if (!inputsChanged && !this.fading) return output;

    if (inputsChanged) {
      if (lod !== this.currentLod) {
        this.fadeFromBuffer.set(output);
        this.fading = true;
        this.fadeStartTime = safeTime;
      }
      this.currentLod = lod;
      this.currentModeCount = nextModeCount;
      this.currentPhase = phase;
      this.lastRawSampleTime = rawSampleTime;
      this.computeRawInto(this.rawTargetBuffer, rawSampleTime, nextModeCount, phase);
    }

    if (!this.fading) {
      output.set(this.rawTargetBuffer);
      this.lastSampleTime = rawSampleTime;
      return output;
    }

    const fadeT = Math.min(1, Math.max(0, (safeTime - this.fadeStartTime) / PROTEIN_MOTION_LOD_FADE_DURATION_SEC));
    for (let index = 0; index < output.length; index += 1) {
      const from = this.fadeFromBuffer[index]!;
      output[index] = from + (this.rawTargetBuffer[index]! - from) * fadeT;
    }
    this.lastSampleTime = safeTime;
    if (fadeT >= 1) this.fading = false;
    return output;
  }

  /** Projects the sampled modal coefficients into `target` as residue xyz offsets. */
  private computeRawInto(target: Float32Array, sampleTime: number, activeModeCount: number, phase: ProteinPhase): void {
    target.fill(0);
    this.effectiveCoefficientsBuffer.fill(0);
    if (activeModeCount === 0) return;
    this.sampler.sampleAt(sampleTime, this.modeCoefficientsBuffer);
    const phaseGain = PROTEIN_MOTION_PHASE_GAINS[phase];
    for (let modeIndex = 0; modeIndex < activeModeCount; modeIndex += 1) {
      const coefficient = this.modeCoefficientsBuffer[modeIndex]! * this.modeGains[modeIndex]! * phaseGain;
      this.effectiveCoefficientsBuffer[modeIndex] = coefficient;
      if (coefficient === 0) continue;
      const displacements = this.modes[modeIndex]!.displacements;
      for (let residueIndex = 0; residueIndex < this.residueCount; residueIndex += 1) {
        const sourceOffset = residueIndex * 3;
        const outputOffset = residueIndex * 4;
        target[outputOffset] = target[outputOffset]! + coefficient * (displacements[sourceOffset] ?? 0);
        target[outputOffset + 1] = target[outputOffset + 1]! + coefficient * (displacements[sourceOffset + 1] ?? 0);
        target[outputOffset + 2] = target[outputOffset + 2]! + coefficient * (displacements[sourceOffset + 2] ?? 0);
      }
    }
  }

  sampleAt(time: number, lod: ProteinMotionLod = this.currentLod, phase: ProteinPhase = this.currentPhase): Float32Array {
    return this.update(time, lod, phase);
  }

  seek(time: number, lod: ProteinMotionLod = this.currentLod, phase: ProteinPhase = this.currentPhase): Float32Array {
    return this.update(time, lod, phase);
  }

  private sampleTimeFor(time: number, lod: ProteinMotionLod): number {
    const safeTime = safeDisplayTime(time);
    const updateHz = updateHzFor(lod);
    if (!Number.isFinite(updateHz)) return safeTime;
    // Quantizing the time from the absolute clock makes coarse updates
    // independent of frame rate. The enemy phase staggers the quantization
    // boundary while the sampler seed keeps each enemy's path independent.
    return Math.floor(safeTime * updateHz + this.updatePhase) / updateHz;
  }
}
