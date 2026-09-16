// 部位のアンカーを引く残基群と、その残基たちの変位の平均。模型座標のままの変位を返す。
import type { ProteinRenderMotion, ProteinRenderSite } from './protein-render-definition';

/** 部位の残基記述子を motion の残基インデックスへ解決する。1つも引けなければ fallbackValues[index](無ければ空)。 */
export function proteinAnchorResidues(
  anchor: ProteinRenderSite,
  index: number,
  motion: ProteinRenderMotion,
  fallbackValues: readonly number[],
): readonly number[] {
  const fallback = fallbackValues[index];
  const resolved: number[] = [];
  // 記述子「残基名 鎖 番号 [原子名]」の鎖と番号で motion の残基を引く。
  for (const descriptor of anchor.residues ?? []) {
    const match = /\s+([^\s]+)\s+(-?\d+)/.exec(descriptor);
    if (!match) continue;
    const chain = match[1]!;
    const number = Number(match[2]);
    for (let residue = 0; residue < motion.residueCount; residue += 1) {
      if (motion.residues.chains[residue] === chain && motion.residues.residueNumbers[residue] === number) {
        resolved.push(residue);
        break;
      }
    }
  }
  if (resolved.length > 0) return [...new Set(resolved)];
  return fallback === undefined ? [] : [fallback];
}

/** 群の残基の xyz 変位を平均する(residueOffsets は残基あたり vec4)。有効な残基が無ければ原点。 */
export function proteinAnchorOffset(
  group: readonly number[],
  residueOffsets: ArrayLike<number>,
  residueCount: number,
): readonly [number, number, number] {
  if (group.length === 0) return [0, 0, 0];
  let x = 0; let y = 0; let z = 0; let count = 0;
  // 有効な残基の変位を足し合わせる。
  for (const residue of group) {
    if (!Number.isInteger(residue) || residue < 0 || residue >= residueCount) continue;
    const offset = residue * 4;
    x += residueOffsets[offset] ?? 0;
    y += residueOffsets[offset + 1] ?? 0;
    z += residueOffsets[offset + 2] ?? 0;
    count += 1;
  }
  return count === 0 ? [0, 0, 0] : [x / count, y / count, z / count];
}
