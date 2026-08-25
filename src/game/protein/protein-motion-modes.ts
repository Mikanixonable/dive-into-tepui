import type { ProteinMotionAsset } from './protein-schema';

const modeDisplacementCache = new WeakMap<ProteinMotionAsset, Float32Array>();

/**
 * asset のモード変位を、GPU がそのまま読める1本のバッファへ平坦化する。
 *
 * 並びは `modeIndex * residueCount + residueIndex`、1要素が vec4(xyz と予約の w)。
 * 結果は asset 単位でキャッシュする — 最大のタンパク質では 1.8MB あり、敵の体数ぶん
 * 複製する価値がない。
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
