// 調整値が作るばらつきの統計。多数の seed の個体を生成して、大きさ・部品数・型・慣性の偏りの
// 分布を数える — スライダーを動かしたとき、ばらつきがどう変わったかを数字で読むための表。
import { generateAssemblyShape } from '../../src/physics/assembly-shape';
import type { AssemblyTuning } from '../../src/physics/assembly-tuning';

export interface VarianceStats {
  readonly count: number;
  readonly outerRadius: { readonly min: number; readonly mean: number; readonly max: number };
  // 部品数 → 個体数。
  readonly partCounts: ReadonlyMap<number, number>;
  // 全体が結び目の個体(部品が結び目)の割合と、結び目部品を1つでも持つ個体の割合。
  readonly wholeKnotRatio: number;
  readonly anyKnotRatio: number;
  // 慣性の最大成分と最小成分の比の平均(1 に近いほど等方で、回転が素直)。
  readonly inertiaSpreadMean: number;
}

// seed の始点から count 個の個体を生成して数える。
export function computeVarianceStats(tuning: AssemblyTuning, firstSeed: number, count: number): VarianceStats {
  let rMin = Infinity;
  let rMax = -Infinity;
  let rSum = 0;
  let wholeKnot = 0;
  let anyKnot = 0;
  let spreadSum = 0;
  const partCounts = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const shape = generateAssemblyShape(firstSeed + i, tuning);
    rMin = Math.min(rMin, shape.outerRadius);
    rMax = Math.max(rMax, shape.outerRadius);
    rSum += shape.outerRadius;
    partCounts.set(shape.parts.length, (partCounts.get(shape.parts.length) ?? 0) + 1);
    const knots = shape.parts.filter((part) => part.kind === 'knot');
    if (knots.length > 0) anyKnot += 1;
    if (knots.some((part) => !part.closed)) wholeKnot += 1;
    const { x, y, z } = shape.inertia;
    spreadSum += Math.max(x, y, z) / Math.max(1e-9, Math.min(x, y, z));
  }
  return {
    count,
    outerRadius: { min: rMin, mean: rSum / count, max: rMax },
    partCounts,
    wholeKnotRatio: wholeKnot / count,
    anyKnotRatio: anyKnot / count,
    inertiaSpreadMean: spreadSum / count,
  };
}
