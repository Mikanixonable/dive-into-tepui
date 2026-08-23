import type { ProteinMotionDefinition } from './protein-schema';

export interface ProteinMotionOffset {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly roll: number;
}

/** Stable across render-object recreation and save/load; unlike Object3D.uuid it is not random. */
export function proteinMotionSeedFor(key: string): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000 * 100;
}

function wave(t: number, frequency: number, phase: number): number {
  return Math.sin(t * frequency + phase) * 0.6 + Math.sin(t * frequency * 1.73 + phase * 1.7) * 0.4;
}

/** A bounded, deterministic OU-like signal suitable for visual motion. */
export function proteinMotionAt(time: number, motion: ProteinMotionDefinition, seed: number): ProteinMotionOffset {
  const amplitude = Math.max(0, motion.amplitude) * Math.min(1, Math.max(0.05, motion.ouSigma * 4));
  const envelope = 0.7 + 0.3 * Math.sin(time * Math.max(0.05, motion.ouTheta) * 0.25 + seed);
  return {
    x: wave(time, 0.65, seed + 0.4) * amplitude * envelope,
    y: wave(time, 0.83, seed + 1.8) * amplitude * envelope,
    z: wave(time, 0.57, seed + 3.1) * amplitude * envelope,
    roll: wave(time, 0.48, seed + 4.2) * amplitude * 0.035 * envelope,
  };
}
