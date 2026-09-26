// parcel footprint と局所接平面の軸平行セルとの有限面積交差を求める。
// footprint は円または回転楕円で、円は等半径楕円として同じ計算経路を通る。

export interface CloudFootprintCircle {
  readonly eastM: number;
  readonly northM: number;
  readonly radiusM: number;
}

// 接平面上の回転楕円。majorAxisAzimuthRad は east から north 向きの主軸方位 [rad]。
// 楕円は方位 π で不変なので、任意の実数値をそのまま受ける。
export interface CloudFootprintEllipse {
  readonly eastM: number;
  readonly northM: number;
  // 長半径・短半径。m。長半径 ≧ 短半径 > 0。
  readonly majorRadiusM: number;
  readonly minorRadiusM: number;
  readonly majorAxisAzimuthRad: number;
}

export type CloudFootprint = CloudFootprintCircle | CloudFootprintEllipse;

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

// 交差計算で使う楕円の正規形。中心相対座標 (x, y) で
// quadraticA·x² + quadraticB·x·y + quadraticC·y² ≦ 1 を満たす領域。
// 短半径 → 0 にはしない(面積が消えて交差が定義できない)ので、呼び出し側で正値を保証する。
interface FootprintEllipseForm {
  readonly eastM: number;
  readonly northM: number;
  // 短半径・長半径。m。
  readonly semiMinorM: number;
  readonly semiMajorM: number;
  // 2次形式の係数。m⁻²。
  readonly quadraticA: number;
  readonly quadraticB: number;
  readonly quadraticC: number;
  // 係数行列の行列式 = 1/(a²·b²)。m⁻⁴。
  readonly determinantPerM4: number;
  // east / north 軸方向の半幅(外接矩形)。m。
  readonly halfWidthEastM: number;
  readonly halfWidthNorthM: number;
  // east 方向の最大到達(鉛直弦が存在する |x| の上限)。m。
  readonly extentEastM: number;
  // 鉛直弦の中心が x とともに動く傾き −B/(2C) の係数。無次元。
  readonly centerlineSlope: number;
  readonly areaM2: number;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

// 円・楕円を共通の 2次形式へ正規化し、有限性と正の面積を保証する。
function ellipseFormOf(footprint: CloudFootprint): FootprintEllipseForm {
  requireFinite(footprint.eastM, 'footprint.eastM');
  requireFinite(footprint.northM, 'footprint.northM');
  let majorRadiusM: number;
  let minorRadiusM: number;
  let azimuthRad: number;
  if ('radiusM' in footprint) {
    majorRadiusM = footprint.radiusM;
    minorRadiusM = footprint.radiusM;
    azimuthRad = 0;
  } else {
    majorRadiusM = footprint.majorRadiusM;
    minorRadiusM = footprint.minorRadiusM;
    azimuthRad = footprint.majorAxisAzimuthRad;
    requireFinite(azimuthRad, 'footprint.majorAxisAzimuthRad');
  }
  requireFinite(majorRadiusM, 'footprint major radius');
  requireFinite(minorRadiusM, 'footprint minor radius');
  if (minorRadiusM <= 0) throw new RangeError('footprint minor radius must be positive');
  if (majorRadiusM < minorRadiusM) {
    throw new RangeError('footprint major radius must not be smaller than minor radius');
  }
  const areaM2 = Math.PI * majorRadiusM * minorRadiusM;
  if (!Number.isFinite(areaM2) || areaM2 <= 0) {
    throw new RangeError('footprint area must be finite and positive');
  }

  const cosAzimuth = Math.cos(azimuthRad);
  const sinAzimuth = Math.sin(azimuthRad);
  const inverseMajorSquaredPerM2 = 1 / (majorRadiusM * majorRadiusM);
  const inverseMinorSquaredPerM2 = 1 / (minorRadiusM * minorRadiusM);
  const quadraticA = cosAzimuth * cosAzimuth * inverseMajorSquaredPerM2
    + sinAzimuth * sinAzimuth * inverseMinorSquaredPerM2;
  const quadraticC = sinAzimuth * sinAzimuth * inverseMajorSquaredPerM2
    + cosAzimuth * cosAzimuth * inverseMinorSquaredPerM2;
  const quadraticB = 2 * cosAzimuth * sinAzimuth
    * (inverseMajorSquaredPerM2 - inverseMinorSquaredPerM2);
  // det = AC − B² は固有値の積 1/(a²·b²) と一致する。近円で AC−B² を直接取ると
  // 相殺するので、解析的に等しい積の形から立てる。
  const determinantPerM4 = inverseMajorSquaredPerM2 * inverseMinorSquaredPerM2;
  return {
    eastM: footprint.eastM,
    northM: footprint.northM,
    semiMinorM: minorRadiusM,
    semiMajorM: majorRadiusM,
    quadraticA,
    quadraticB,
    quadraticC,
    determinantPerM4,
    halfWidthEastM: Math.sqrt(
      majorRadiusM * majorRadiusM * cosAzimuth * cosAzimuth
        + minorRadiusM * minorRadiusM * sinAzimuth * sinAzimuth,
    ),
    halfWidthNorthM: Math.sqrt(
      majorRadiusM * majorRadiusM * sinAzimuth * sinAzimuth
        + minorRadiusM * minorRadiusM * cosAzimuth * cosAzimuth,
    ),
    extentEastM: majorRadiusM * minorRadiusM * Math.sqrt(quadraticC),
    centerlineSlope: quadraticB / (2 * quadraticC),
    areaM2,
  };
}

function validateGrid(grid: CloudFootprintGrid): number {
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
  const cellAreaM2 = grid.cellWidthM * grid.cellHeightM;
  if (!Number.isFinite(cellAreaM2) || cellAreaM2 <= 0) {
    throw new RangeError('grid cell area must be finite and positive');
  }
  return cellAreaM2;
}

// 楕円と矩形の交差を、x ごとの楕円内鉛直弦と矩形 y 区間の共通長として積分する。
// 回転楕円でも x を固定すると内部 y は区間 [−slope·x ± h(x)] で、h(x) は円と同じ
// √(X²−x²) 型のプロファイルを持つ — 傾いた中心線の線形項を足すだけで、
// 円のときと同じ部分区分積分がそのまま使える。
function ellipseRectangleAreaM2(
  form: FootprintEllipseForm,
  leftM: number,
  bottomM: number,
  rightM: number,
  topM: number,
): number {
  const extentEastM = form.extentEastM;
  const left = Math.max(leftM - form.eastM, -extentEastM);
  const right = Math.min(rightM - form.eastM, extentEastM);
  if (left >= right || bottomM >= topM) return 0;

  const topRelativeM = topM - form.northM;
  const bottomRelativeM = bottomM - form.northM;
  const slope = form.centerlineSlope;
  const quadraticC = form.quadraticC;
  const determinant = form.determinantPerM4;

  // 鉛直弦の半長 h(x) = √(C − det·x²)/C 。
  const halfChord = (x: number): number => (
    Math.sqrt(Math.max(0, quadraticC - determinant * x * x)) / quadraticC
  );
  // 矩形上下端との共通長。上端側は min(top − y₀, +h)、下端側は max(bottom − y₀, −h)。
  const chordIntersectionLength = (x: number): number => {
    const half = halfChord(x);
    const centerM = -slope * x;
    return Math.max(0, Math.min(topRelativeM - centerM, half)
      - Math.max(bottomRelativeM - centerM, -half));
  };

  // 端のクランプが切り替わる位置だけを積分の区切りにする。矩形の上下端
  // y = c と弦端 c − y₀(x) = ±h(x) の交点は (c + slope·x)² = h(x)² の二次方程式で、
  // 各辺につき高々2本の根を持つ。
  const breakpoints = [left, right];
  const determinantCm2 = determinant * quadraticC;
  const chordDenominator = slope * slope * quadraticC * quadraticC + determinant;
  for (const edgeRelativeM of [bottomRelativeM, topRelativeM]) {
    const discriminant = quadraticC
      * (chordDenominator - determinantCm2 * edgeRelativeM * edgeRelativeM);
    if (discriminant <= 0) continue;
    const halfRoot = Math.sqrt(discriminant);
    const linearTerm = edgeRelativeM * slope * quadraticC * quadraticC;
    for (const candidate of [
      (-linearTerm - halfRoot) / chordDenominator,
      (-linearTerm + halfRoot) / chordDenominator,
    ]) {
      if (candidate > left && candidate < right) breakpoints.push(candidate);
    }
  }
  breakpoints.sort((a, b) => a - b);

  // ∫h(x)dx を端部側の積 ∫_x^X h dt の差として取る(円のときと同じ構造)。
  const rootTailIntegralM2 = (x: number): number => {
    const normalizedX = Math.max(-1, Math.min(1, x / extentEastM));
    const half = Math.sqrt(Math.max(0,
      (extentEastM - x) * (extentEastM + x)));
    const q = half / extentEastM;
    const areaScaleM2 = form.semiMinorM * form.semiMajorM;
    if (q < 1e-3) {
      const q2 = q * q;
      return areaScaleM2 * q * q2
        * (1 / 3 + q2 * (1 / 10 + q2 * (3 / 56 + q2 * (5 / 144))));
    }
    return areaScaleM2 * (Math.acos(normalizedX) - normalizedX * q) / 2;
  };
  const rootIntegralM2 = (a: number, b: number): number => {
    if (a >= 0) return rootTailIntegralM2(a) - rootTailIntegralM2(b);
    if (b <= 0) return rootTailIntegralM2(-b) - rootTailIntegralM2(-a);
    const quarterAreaM2 = form.areaM2 / 4;
    return quarterAreaM2 * 2 - rootTailIntegralM2(-a) - rootTailIntegralM2(b);
  };
  // 傾いた中心線を含む矩形端の線形積分。∫(c + slope·x)dx は中点値×幅で厳密。
  let areaM2 = 0;
  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const a = breakpoints[index]!;
    const b = breakpoints[index + 1]!;
    const middle = (a + b) / 2;
    const fm = chordIntersectionLength(middle);
    if (fm <= 0) continue;
    const rootIntegral = rootIntegralM2(a, b);
    const centerAtMiddleM = -slope * middle;
    const upperLimitM = topRelativeM - centerAtMiddleM;
    const lowerLimitM = bottomRelativeM - centerAtMiddleM;
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

// 点評価に使う footprint の 2次形式。同じ footprint へ多数の点を評価するときは、
// 楕円の三角関数を点ごとに解き直さないよう、先に cloudFootprintQuadraticForm で正規化する。
export interface CloudFootprintQuadratic {
  readonly eastM: number;
  readonly northM: number;
  // 2次形式の係数。m⁻²。
  readonly quadraticA: number;
  readonly quadraticB: number;
  readonly quadraticC: number;
}

// footprint を点評価の 2次形式へ正規化する。
export function cloudFootprintQuadraticForm(
  footprint: CloudFootprint,
): CloudFootprintQuadratic {
  return ellipseFormOf(footprint);
}

// footprint の 2次形式を接平面上の 1 点で評価する。戻り値が 1 以下ならその点は内部。
export function cloudFootprintQuadraticAt(
  quadratic: CloudFootprintQuadratic, eastM: number, northM: number,
): number {
  requireFinite(eastM, 'eastM');
  requireFinite(northM, 'northM');
  const offsetEastM = eastM - quadratic.eastM;
  const offsetNorthM = northM - quadratic.northM;
  return quadratic.quadraticA * offsetEastM * offsetEastM
    + quadratic.quadraticB * offsetEastM * offsetNorthM
    + quadratic.quadraticC * offsetNorthM * offsetNorthM;
}

// footprint を交差するセルだけを row-major cellIndex で返す。格子外部分は overlaps に含めない。
export function cloudFootprintOverlap(
  footprint: CloudFootprint,
  grid: CloudFootprintGrid,
): CloudFootprintCoverage {
  const form = ellipseFormOf(footprint);
  validateGrid(grid);
  const gridRightM = grid.originEastM + grid.width * grid.cellWidthM;
  const gridTopM = grid.originNorthM + grid.height * grid.cellHeightM;
  if (!Number.isFinite(gridRightM) || !Number.isFinite(gridTopM)) {
    throw new RangeError('grid extent must be finite');
  }
  const firstColumn = Math.max(0,
    Math.floor((form.eastM - form.halfWidthEastM - grid.originEastM) / grid.cellWidthM));
  const lastColumn = Math.min(grid.width - 1,
    Math.floor((form.eastM + form.halfWidthEastM - grid.originEastM) / grid.cellWidthM));
  const firstRow = Math.max(0,
    Math.floor((form.northM - form.halfWidthNorthM - grid.originNorthM) / grid.cellHeightM));
  const lastRow = Math.min(grid.height - 1,
    Math.floor((form.northM + form.halfWidthNorthM - grid.originNorthM) / grid.cellHeightM));
  const overlaps: CloudFootprintOverlap[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    const bottomM = grid.originNorthM + row * grid.cellHeightM;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const leftM = grid.originEastM + column * grid.cellWidthM;
      const rawAreaM2 = ellipseRectangleAreaM2(
        form, leftM, bottomM, leftM + grid.cellWidthM, bottomM + grid.cellHeightM,
      );
      const geometricAreaLimitM2 = Math.min(grid.cellWidthM * grid.cellHeightM, form.areaM2);
      // 中間量は半軸の積のスケールまで膨らむ(rootTailIntegralM2 の差し引き)ので、
      // 丸めの許容差にもそれを含める。
      const intermediateScaleM2 = form.semiMajorM * form.semiMinorM;
      const roundingToleranceM2 = 32 * Number.EPSILON * Math.max(
        rawAreaM2, geometricAreaLimitM2, intermediateScaleM2);
      if (rawAreaM2 - geometricAreaLimitM2 > roundingToleranceM2) {
        throw new RangeError('footprint-rectangle overlap exceeds its geometric area limit');
      }
      const areaM2 = Math.min(rawAreaM2, geometricAreaLimitM2);
      if (areaM2 > 0) overlaps.push({ cellIndex: row * grid.width + column, areaM2 });
    }
  }
  return { footprintAreaM2: form.areaM2, overlaps };
}
