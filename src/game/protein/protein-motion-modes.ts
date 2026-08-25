import type { ProteinMotionAsset } from './protein-schema';

const modeDisplacementCache = new WeakMap<ProteinMotionAsset, Float32Array>();

/**
 * Flattens an asset's ANM mode displacements into one GPU-ready buffer.
 *
 * Layout is `modeIndex * residueCount + residueIndex`, one vec4 (xyz +
 * reserved w) per entry, so the GPU can index it as `mode[m * residueCount + i]`.
 * The result is cached per asset — assets are shared across every enemy body
 * of that kind, and duplicating this buffer per body would cost 1.8MB each
 * for the largest protein (4713 residues × 24 modes × 16 bytes).
 */
export function proteinMotionModeDisplacements(asset: ProteinMotionAsset): Float32Array {
  const cached = modeDisplacementCache.get(asset);
  if (cached) return cached;

  const residueCount = asset.residueCount;
  const modeCount = asset.modes.length;
  const flattened = new Float32Array(modeCount * residueCount * 4);
  for (let modeIndex = 0; modeIndex < modeCount; modeIndex += 1) {
    const displacements = asset.modes[modeIndex]!.displacements;
    const modeBase = modeIndex * residueCount * 4;
    for (let residueIndex = 0; residueIndex < residueCount; residueIndex += 1) {
      const sourceOffset = residueIndex * 3;
      const targetOffset = modeBase + residueIndex * 4;
      flattened[targetOffset] = displacements[sourceOffset] ?? 0;
      flattened[targetOffset + 1] = displacements[sourceOffset + 1] ?? 0;
      flattened[targetOffset + 2] = displacements[sourceOffset + 2] ?? 0;
    }
  }
  modeDisplacementCache.set(asset, flattened);
  return flattened;
}
