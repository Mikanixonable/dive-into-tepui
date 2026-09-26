// 円形 parcel footprint と局所接平面の軸平行セルとの有限面積交差を求める。

export interface CloudFootprintCircle {
  readonly eastM: number;
  readonly northM: number;
  readonly radiusM: number;
}

export interface CloudFootprintGrid {
  readonly originEastM: number;
  readonly originNorthM: number;
  readonly cellWidthM: number;
  readonly cellHeightM: number;
  readonly width: number;
  readonly height: number;
}

export interface CloudFootprintOverlap {
  readonly cellIndex: number;
  readonly areaM2: number;
}

export interface CloudFootprintCoverage {
  readonly footprintAreaM2: number;
  readonly overlaps: readonly CloudFootprintOverlap[];
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function validate(circle: CloudFootprintCircle, grid: CloudFootprintGrid): number {
  requireFinite(circle.eastM, 'circle.eastM');
  requireFinite(circle.northM, 'circle.northM');
  requireFinite(circle.radiusM, 'circle.radiusM');
  if (circle.radiusM <= 0) throw new RangeError('circle.radiusM must be positive');
  for (const [name, value] of Object.entries({
    originEastM: grid.originEastM,
    originNorthM: grid.originNorthM,
    cellWidthM: grid.cellWidthM,
    cellHeightM: grid.cellHeightM,
  })) requireFinite(value, `grid.${name}`);
  if (grid.cellWidthM <= 0 || grid.cellHeightM <= 0) {
    throw new RangeError('grid cell dimensions must be positive');
  }
  if (!Number.isSafeInteger(grid.width) || grid.width <= 0
    || !Number.isSafeInteger(grid.height) || grid.height <= 0
    || !Number.isSafeInteger(grid.width * grid.height)) {
    throw new RangeError('grid dimensions must be positive safe integers');
  }
  const footprintAreaM2 = Math.PI * circle.radiusM * circle.radiusM;
  const cellAreaM2 = grid.cellWidthM * grid.cellHeightM;
  if (!Number.isFinite(footprintAreaM2) || footprintAreaM2 <= 0) {
    throw new RangeError('circle footprint area must be finite and positive');
  }
  if (!Number.isFinite(cellAreaM2) || cellAreaM2 <= 0) {
    throw new RangeError('grid cell area must be finite and positive');
  }
  return footprintAreaM2;
}

// 円と矩形の交差を、x ごとの円内 vertical chord と矩形 y 区間の長さとして積分する。
function circleRectangleAreaM2(
  circle: CloudFootprintCircle,
  leftM: number,
  bottomM: number,
  rightM: number,
  topM: number,
): number {
  const radiusM = circle.radiusM;
  const left = Math.max(leftM - circle.eastM, -radiusM);
  const right = Math.min(rightM - circle.eastM, radiusM);
  if (left >= right || bottomM >= topM) return 0;

  const halfChord = (x: number): number => Math.sqrt(Math.max(0, radiusM * radiusM - x * x));
  const chordIntersectionLength = (x: number): number => {
    const half = halfChord(x);
    return Math.max(0, Math.min(topM - circle.northM, half)
      - Math.max(bottomM - circle.northM, -half));
  };

  const breakpoints = [left, right];
  for (const edgeM of [bottomM - circle.northM, topM - circle.northM]) {
    if (Math.abs(edgeM) >= radiusM) continue;
    const x = Math.sqrt((radiusM - Math.abs(edgeM)) * (radiusM + Math.abs(edgeM)));
    for (const crossing of [-x, x]) {
      if (crossing > left && crossing < right) breakpoints.push(crossing);
    }
  }
  breakpoints.sort((a, b) => a - b);

  const rootTailIntegralM2 = (x: number): number => {
    const normalizedX = Math.max(0, Math.min(1, x / radiusM));
    const half = Math.sqrt(Math.max(0, (radiusM - x) * (radiusM + x)));
    const q = half / radiusM;
    if (q < 1e-3) {
      const q2 = q * q;
      return radiusM * radiusM * q * q2 * (1 / 3 + q2 * (1 / 10 + q2 * (3 / 56 + q2 * (5 / 144))));
    }
    return radiusM * radiusM * (Math.acos(normalizedX) - normalizedX * q) / 2;
  };
  const rootIntegralM2 = (a: number, b: number): number => {
    if (a >= 0) return rootTailIntegralM2(a) - rootTailIntegralM2(b);
    if (b <= 0) return rootTailIntegralM2(-b) - rootTailIntegralM2(-a);
    const quarterCircleAreaM2 = Math.PI * radiusM * radiusM / 4;
    return quarterCircleAreaM2 * 2 - rootTailIntegralM2(-a) - rootTailIntegralM2(b);
  };
  let areaM2 = 0;
  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const a = breakpoints[index]!;
    const b = breakpoints[index + 1]!;
    const middle = (a + b) / 2;
    const fm = chordIntersectionLength(middle);
    if (fm <= 0) continue;
    const rootIntegral = rootIntegralM2(a, b);
    const upperLimitM = topM - circle.northM;
    const lowerLimitM = bottomM - circle.northM;
    const upperAtMiddleM = halfChord(middle);
    const lowerAtMiddleM = -upperAtMiddleM;
    const upperIntegral = upperLimitM <= upperAtMiddleM
      ? upperLimitM * (b - a)
      : rootIntegral;
    const lowerIntegral = lowerLimitM >= lowerAtMiddleM
      ? lowerLimitM * (b - a)
      : -rootIntegral;
    areaM2 += upperIntegral - lowerIntegral;
  }
  return Math.max(0, areaM2);
}

// footprint を交差するセルだけを row-major cellIndex で返す。格子外部分は overlaps に含めない。
export function cloudFootprintOverlap(
  circle: CloudFootprintCircle,
  grid: CloudFootprintGrid,
): CloudFootprintCoverage {
  const footprintAreaM2 = validate(circle, grid);
  const gridRightM = grid.originEastM + grid.width * grid.cellWidthM;
  const gridTopM = grid.originNorthM + grid.height * grid.cellHeightM;
  if (!Number.isFinite(gridRightM) || !Number.isFinite(gridTopM)) {
    throw new RangeError('grid extent must be finite');
  }
  const firstColumn = Math.max(0, Math.floor((circle.eastM - circle.radiusM - grid.originEastM) / grid.cellWidthM));
  const lastColumn = Math.min(grid.width - 1,
    Math.floor((circle.eastM + circle.radiusM - grid.originEastM) / grid.cellWidthM));
  const firstRow = Math.max(0, Math.floor((circle.northM - circle.radiusM - grid.originNorthM) / grid.cellHeightM));
  const lastRow = Math.min(grid.height - 1,
    Math.floor((circle.northM + circle.radiusM - grid.originNorthM) / grid.cellHeightM));
  const overlaps: CloudFootprintOverlap[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    const bottomM = grid.originNorthM + row * grid.cellHeightM;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const leftM = grid.originEastM + column * grid.cellWidthM;
      const rawAreaM2 = circleRectangleAreaM2(
        circle, leftM, bottomM, leftM + grid.cellWidthM, bottomM + grid.cellHeightM,
      );
      const geometricAreaLimitM2 = Math.min(grid.cellWidthM * grid.cellHeightM, footprintAreaM2);
      // 中間量は半径の二乗のスケールまで膨らむ(rootTailIntegralM2 の差し引き)ので、
      // 丸めの許容差にもそれを含める。
      const roundingToleranceM2 = 32 * Number.EPSILON * Math.max(
        rawAreaM2, geometricAreaLimitM2, circle.radiusM * circle.radiusM);
      if (rawAreaM2 - geometricAreaLimitM2 > roundingToleranceM2) {
        throw new RangeError('circle-rectangle overlap exceeds its geometric area limit');
      }
      const areaM2 = Math.min(rawAreaM2, geometricAreaLimitM2);
      if (areaM2 > 0) overlaps.push({ cellIndex: row * grid.width + column, areaM2 });
    }
  }
  return { footprintAreaM2, overlaps };
}
