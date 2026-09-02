import { qInvert, qRotate, type Quat } from '../../math/quat';
import { add, sub, type Vec3, v3 } from '../../math/vec3';
import type {
  ProteinModificationDefinition,
  ProteinMotionAsset,
  ProteinSiteDefinition,
} from './protein-schema';

type AnchorDefinition = ProteinSiteDefinition | ProteinModificationDefinition;

/** Resolve a semantic anchor's residue descriptors to motion-asset indices. */
export function proteinAnchorResidues(
  anchor: AnchorDefinition,
  index: number,
  motion: ProteinMotionAsset,
  fallbackValues: readonly number[],
): readonly number[] {
  const fallback = fallbackValues[index];
  const resolved: number[] = [];
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

/** Average the xyz displacement of all residues associated with an anchor. */
export function proteinAnchorOffset(
  group: readonly number[],
  residueOffsets: ArrayLike<number>,
  residueCount: number,
): readonly [number, number, number] {
  if (group.length === 0) return [0, 0, 0];
  let x = 0; let y = 0; let z = 0; let count = 0;
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

/** Compute an active-site world position from its static coordinate and residue motion. */
export function proteinSiteWorldPosition(
  site: ProteinSiteDefinition | null,
  group: readonly number[],
  residueOffsets: ArrayLike<number>,
  residueCount: number,
  coordinateScale: number,
  rootScale: number,
  origin: Vec3,
  attitude: Quat,
): Vec3 {
  if (!site) return origin;
  const [x, y, z] = site.position;
  const offset = proteinAnchorOffset(group, residueOffsets, residueCount);
  const scale = coordinateScale * rootScale;
  const local = v3((x + offset[0]) * scale, (y + offset[1]) * scale, (z + offset[2]) * scale);
  return add(origin, qRotate(attitude, local));
}

/** Convert a world impact point into the protein runtime's local coordinate system. */
export function proteinLocalImpactPoint(worldPoint: Vec3, origin: Vec3, attitude: Quat, rootScale: number): Vec3 {
  const oriented = qRotate(qInvert(attitude), sub(worldPoint, origin));
  return v3(oriented.x / rootScale, oriented.y / rootScale, oriented.z / rootScale);
}
