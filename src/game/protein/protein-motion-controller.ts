import {
  ProteinBrownianSampler,
  proteinBrownianSeedFor,
} from './protein-brownian-motion';
import type { ProteinMotionAsset } from './protein-schema';

type ProteinMotionBand = ProteinMotionAsset['modes'][number]['band'];

export type ProteinMotionLod = 'near' | 'medium' | 'far' | 'marker';

export const PROTEIN_MOTION_LOD_MODE_COUNTS: Readonly<Record<ProteinMotionLod, number>> = {
  near: 24,
  medium: 12,
  far: 4,
  marker: 0,
};

/** Distance-based fallback used by the entity sync path when projected size is unavailable. */
export function proteinMotionLodForDistance(distance: number, visualRadius: number): ProteinMotionLod {
  const safeDistance = Number.isFinite(distance) && distance >= 0 ? distance : Number.POSITIVE_INFINITY;
  const safeRadius = Number.isFinite(visualRadius) && visualRadius > 0 ? visualRadius : 1;
  if (safeDistance <= safeRadius * 24) return 'near';
  if (safeDistance <= safeRadius * 96) return 'medium';
  if (safeDistance <= safeRadius * 384) return 'far';
  return 'marker';
}

const MAX_MOTION_MODES = PROTEIN_MOTION_LOD_MODE_COUNTS.near;
const MEDIUM_UPDATE_HZ = 30;
const FAR_UPDATE_HZ = 15;
const UINT32_SCALE = 0x1_0000_0000;

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
  private readonly residueOffsetsBuffer: Float32Array;
  private readonly modeGains: Float64Array;
  private currentLod: ProteinMotionLod = 'near';
  private currentModeCount = 0;
  private lastSampleTime = Number.NaN;

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
    this.residueOffsetsBuffer = new Float32Array(this.residueCount * 4);
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
   * without changing the deterministic sampling semantics.
   */
  update(time: number, lod: ProteinMotionLod = 'near'): Float32Array {
    const nextModeCount = modeCountFor(lod, this.modeCount);
    const output = this.residueOffsetsBuffer;
    const sampleTime = nextModeCount === 0 ? 0 : this.sampleTimeFor(time, lod);
    if (lod === this.currentLod && nextModeCount === this.currentModeCount && sampleTime === this.lastSampleTime) {
      return output;
    }
    this.currentLod = lod;
    this.currentModeCount = nextModeCount;

    if (this.currentModeCount === 0) {
      output.fill(0);
      this.lastSampleTime = sampleTime;
      return output;
    }

    output.fill(0);
    this.sampler.sampleAt(sampleTime, this.modeCoefficientsBuffer);
    for (let modeIndex = 0; modeIndex < this.currentModeCount; modeIndex += 1) {
      const coefficient = this.modeCoefficientsBuffer[modeIndex]! * this.modeGains[modeIndex]!;
      if (coefficient === 0) continue;
      const displacements = this.modes[modeIndex]!.displacements;
      for (let residueIndex = 0; residueIndex < this.residueCount; residueIndex += 1) {
        const sourceOffset = residueIndex * 3;
        const outputOffset = residueIndex * 4;
        output[outputOffset] = output[outputOffset]! + coefficient * (displacements[sourceOffset] ?? 0);
        output[outputOffset + 1] = output[outputOffset + 1]! + coefficient * (displacements[sourceOffset + 1] ?? 0);
        output[outputOffset + 2] = output[outputOffset + 2]! + coefficient * (displacements[sourceOffset + 2] ?? 0);
      }
    }
    this.lastSampleTime = sampleTime;
    return output;
  }

  sampleAt(time: number, lod: ProteinMotionLod = this.currentLod): Float32Array {
    return this.update(time, lod);
  }

  seek(time: number, lod: ProteinMotionLod = this.currentLod): Float32Array {
    return this.update(time, lod);
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
