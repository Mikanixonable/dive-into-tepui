// 呼び出し側が渡す平面多角形上で ABI スカラー値を照合する。
// 局所接平面での多角形交差面積は厳密に求めるが、固定格子の変換、地球曲率、視差、
// 画素内の地図縮尺変化は扱わない。

export interface AbiCollocationPoint {
  readonly x: number;
  readonly y: number;
}

export interface AbiScalarSourcePixel {
  readonly footprint: readonly AbiCollocationPoint[];
  readonly value: number | null;
  readonly validMask: boolean;
}

export interface AbiScalarCollocationResult {
  /** 面積加重平均。品質を通る被覆が不足する場合は null。 */
  readonly value: number | null;
  /** 品質を通った重なり面積を対象多角形の面積で割った比率。 */
  readonly validCoverageFraction: number;
  readonly validOverlapArea: number;
  readonly targetArea: number;
  readonly sufficientCoverage: boolean;
}

interface Point { readonly x: number; readonly y: number }
interface Bounds { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }

/** 平面上の凸多角形の交差面積でスカラー場を照合する。無効・mask 済み画素は面積にも値にも加えず、
 * 被覆不足は null で返し、値を補って埋めない。 */
export function collocateAbiScalarToFootprint(
  sources: readonly AbiScalarSourcePixel[],
  targetFootprint: readonly AbiCollocationPoint[],
  minimumValidCoverageFraction: number,
): AbiScalarCollocationResult {
  const target = validateConvexPolygon(targetFootprint, 'target footprint');
  const targetArea = polygonArea(target);
  if (!Number.isFinite(minimumValidCoverageFraction)
    || minimumValidCoverageFraction < 0 || minimumValidCoverageFraction > 1) {
    throw new Error('Minimum valid coverage fraction must be between zero and one');
  }

  let weightedValue = 0;
  let validOverlapArea = 0;
  const validFootprints: { readonly polygon: readonly Point[]; readonly bounds: Bounds }[] = [];
  for (const source of sources) {
    const footprint = validateConvexPolygon(source.footprint, 'source footprint');
    if (source.validMask !== true || source.value === null) continue;
    if (!Number.isFinite(source.value)) throw new Error('Valid source scalar values must be finite');
    const bounds = polygonBounds(footprint);
    for (const previous of validFootprints) {
      if (!boundsOverlap(bounds, previous.bounds)) continue;
      const common = intersectConvexPolygons(
        intersectConvexPolygons(footprint, previous.polygon), target,
      );
      if (polygonArea(common) > targetArea * 1e-10) {
        throw new Error('Valid source footprints overlap within the target footprint');
      }
    }
    validFootprints.push({ polygon: footprint, bounds });
    const overlap = polygonArea(intersectConvexPolygons(target, footprint));
    if (overlap === 0) continue;
    validOverlapArea += overlap;
    weightedValue += overlap * source.value;
  }
  if (!Number.isFinite(validOverlapArea) || !Number.isFinite(weightedValue)) {
    throw new Error('Collocation overlap and weighted value must be finite');
  }

  const tolerance = targetArea * 1e-10;
  if (validOverlapArea > targetArea + tolerance) {
    throw new Error('Valid source footprints overlap within the target footprint');
  }
  const coverage = Math.min(1, validOverlapArea / targetArea);
  const sufficientCoverage = validOverlapArea > 0 && coverage >= minimumValidCoverageFraction;
  return {
    value: sufficientCoverage && validOverlapArea > 0 ? weightedValue / validOverlapArea : null,
    validCoverageFraction: coverage,
    validOverlapArea,
    targetArea,
    sufficientCoverage,
  };
}

/** 有限かつ非退化な凸多角形を検証し、反時計回りへ揃える。 */
function validateConvexPolygon(vertices: readonly AbiCollocationPoint[], label: string): readonly Point[] {
  if (vertices.length < 3) throw new Error(`${label} must have at least three vertices`);
  const points = vertices.map(({ x, y }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label} coordinates must be finite`);
    return { x, y };
  });
  const area = signedArea(points);
  if (!Number.isFinite(area) || Math.abs(area) <= Number.EPSILON) {
    throw new Error(`${label} must have non-zero area`);
  }
  const orientation = Math.sign(area);
  let hasTurn = false;
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[index]!;
    const current = points[(index + 1) % points.length]!;
    const next = points[(index + 2) % points.length]!;
    const turn = cross(subtract(current, previous), subtract(next, current));
    if (Math.abs(turn) <= Number.EPSILON) continue;
    if (Math.sign(turn) !== orientation) throw new Error(`${label} must be convex and consistently ordered`);
    hasTurn = true;
  }
  if (!hasTurn) throw new Error(`${label} must have non-zero area`);
  return orientation > 0 ? points : points.reverse();
}

/** 両多角形を反時計回りとして Sutherland–Hodgman 法で交差領域を切り出す。 */
function intersectConvexPolygons(subject: readonly Point[], clip: readonly Point[]): readonly Point[] {
  let output = [...subject];
  for (let edge = 0; edge < clip.length && output.length > 0; edge += 1) {
    const edgeStart = clip[edge]!;
    const edgeEnd = clip[(edge + 1) % clip.length]!;
    const input = output;
    output = [];
    let start = input[input.length - 1]!;
    for (const end of input) {
      const startInside = isLeftOfEdge(edgeStart, edgeEnd, start);
      const endInside = isLeftOfEdge(edgeStart, edgeEnd, end);
      if (endInside) {
        if (!startInside) output.push(lineIntersection(start, end, edgeStart, edgeEnd));
        output.push(end);
      } else if (startInside) {
        output.push(lineIntersection(start, end, edgeStart, edgeEnd));
      }
      start = end;
    }
  }
  return output;
}

function isLeftOfEdge(start: Point, end: Point, point: Point): boolean {
  return cross(subtract(end, start), subtract(point, start)) >= 0;
}

function lineIntersection(start: Point, end: Point, edgeStart: Point, edgeEnd: Point): Point {
  const segment = subtract(end, start);
  const edge = subtract(edgeEnd, edgeStart);
  const denominator = cross(segment, edge);
  if (Math.abs(denominator) <= Number.EPSILON) return end;
  const fraction = cross(subtract(edgeStart, start), edge) / denominator;
  return { x: start.x + fraction * segment.x, y: start.y + fraction * segment.y };
}

function polygonArea(points: readonly Point[]): number {
  return Math.abs(signedArea(points));
}

function signedArea(points: readonly Point[]): number {
  if (points.length < 3) return 0;
  const origin = points[0]!;
  let twiceArea = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    twiceArea += cross(subtract(points[index]!, origin), subtract(points[index + 1]!, origin));
  }
  return twiceArea / 2;
}

function polygonBounds(points: readonly Point[]): Bounds {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return left.minX < right.maxX && right.minX < left.maxX
    && left.minY < right.maxY && right.minY < left.maxY;
}

function subtract(left: Point, right: Point): Point {
  return { x: left.x - right.x, y: left.y - right.y };
}

function cross(left: Point, right: Point): number {
  return left.x * right.y - left.y * right.x;
}
