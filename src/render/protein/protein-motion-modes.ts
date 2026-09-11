// asset のモード基底を残基の変位へ畳む。GPU へ渡す平坦バッファと、CPU で必要な残基だけを
// 求める投影の両方をここが持つ。
import type { ProteinRenderMotion } from './protein-render-definition';

const modeDisplacementCache = new WeakMap<ProteinRenderMotion, Float32Array>();

/**
 * asset のモード変位を、GPU がそのまま読める1本のバッファへ平坦化する。
 *
 * 並びは `modeIndex * residueCount + residueIndex`、1要素が vec4(xyz と予約の w)。
 * 結果は asset 単位でキャッシュする — 最大のタンパク質では 1.8MB あり、敵の体数ぶん
 * 複製する価値がない。
 */
export function proteinMotionModeDisplacements(asset: ProteinRenderMotion): Float32Array {
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

/**
 * 確定済みのモード係数を、列挙された残基についてだけ `target`(残基あたり vec4)へ投影する。
 * 列挙されなかった残基の要素は書き換えない。範囲外・非整数の残基インデックスは無視する。
 */
export function projectProteinResidues(
  asset: ProteinRenderMotion, coefficients: Float32Array,
  residues: readonly number[], target: Float32Array,
): void {
  // 対象残基ごとに、全モードの線形結合を同じ係数バッファから再現する。
  for (const residue of residues) {
    if (!Number.isInteger(residue) || residue < 0 || residue >= asset.residueCount) continue;
    const sourceOffset = residue * 3;
    const outputOffset = residue * 4;
    let x = 0; let y = 0; let z = 0;
    for (let modeIndex = 0; modeIndex < asset.modes.length; modeIndex += 1) {
      const coefficient = coefficients[modeIndex] ?? 0;
      if (coefficient === 0) continue;
      const displacements = asset.modes[modeIndex]!.displacements;
      x += coefficient * (displacements[sourceOffset] ?? 0);
      y += coefficient * (displacements[sourceOffset + 1] ?? 0);
      z += coefficient * (displacements[sourceOffset + 2] ?? 0);
    }
    target[outputOffset] = x;
    target[outputOffset + 1] = y;
    target[outputOffset + 2] = z;
  }
}
