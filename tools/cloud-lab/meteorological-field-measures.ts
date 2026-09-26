// 局所格子場の形態量を測る計測群。連結成分・穴率・重心・時系列の存続を、
// 生成側の形態実装へ依存しない単純な演算で求める。
// fixture 場にも、焼かれた光学場の層抽出にも同じ演算を当てる。
import type { CloudExtinctionLayer } from '../../src/game/cloud/cloud-mass-extinction';
import type { CloudOpticalVolumeData } from '../../src/render/cloud/cloud-optical-volume';

// 一つの高度層に対応する二次元の消散(またはメンバシップ)平面。
export interface CloudFieldPlane {
  readonly width: number;
  readonly height: number;
  readonly cellWidthM: number;
  readonly cellHeightM: number;
  // 格子の西端・南端 [m]。セル中心の座標は origin + (index + 0.5) * cell。
  readonly originEastM: number;
  readonly originNorthM: number;
  // 行(北)・列(東)の row-major。意味は呼び出し側のマスクまたは消散係数。
  readonly values: Float32Array;
}

export type MemberSense = 'above' | 'at-or-below';

function requirePlane(plane: CloudFieldPlane): void {
  if (!Number.isSafeInteger(plane.width) || plane.width <= 0
    || !Number.isSafeInteger(plane.height) || plane.height <= 0) {
    throw new RangeError('plane dimensions must be positive integers');
  }
  if (!(plane.values instanceof Float32Array)
    || plane.values.length !== plane.width * plane.height) {
    throw new RangeError('plane values must be a Float32Array of width * height');
  }
  if (!(plane.cellWidthM > 0) || !(plane.cellHeightM > 0)) {
    throw new RangeError('plane cell dimensions must be positive');
  }
}

// 閾値でセルをメンバ/非メンバへ分ける。雲は 'above'、穴(雲の無い成分)は 'at-or-below'。
export function fieldMemberMask(
  plane: CloudFieldPlane,
  memberThreshold: number,
  sense: MemberSense,
): Uint8Array {
  requirePlane(plane);
  const mask = new Uint8Array(plane.values.length);
  for (let index = 0; index < plane.values.length; index += 1) {
    mask[index] = sense === 'above'
      ? (plane.values[index]! > memberThreshold ? 1 : 0)
      : (plane.values[index]! <= memberThreshold ? 1 : 0);
  }
  return mask;
}

export interface FieldComponent {
  // メンバセルの個数。
  readonly cellCount: number;
  // 値の総和。マスク成分では cellCount と同じになる。
  readonly valueSum: number;
  // メンバセルのうち一つでも格子縁に接していれば真。穴の内外判定に使う。
  readonly touchesBoundary: boolean;
  // 値で重み付けした重心の接平面座標 [m]。
  readonly centroidEastM: number;
  readonly centroidNorthM: number;
}

export interface LabeledField {
  // セルごとの成分番号。非メンバは -1。
  readonly labels: Int32Array;
  readonly components: readonly FieldComponent[];
}

// 4/8 近傍の連結成分。メンバセルだけを番号付けし、各成分の個数・値・縁接触・重心を返す。
export function labelMaskComponents(
  memberCells: Uint8Array,
  width: number,
  height: number,
  cellWidthM: number,
  cellHeightM: number,
  originEastM: number,
  originNorthM: number,
  values: Float32Array | null,
  diagonal: boolean,
): LabeledField {
  if (memberCells.length !== width * height || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('mask dimensions must match a positive width * height');
  }
  if (values !== null && values.length !== memberCells.length) {
    throw new RangeError('weighted labels require values sized as the mask');
  }
  const labels = new Int32Array(memberCells.length).fill(-1);
  const components: FieldComponent[] = [];
  const stack: number[] = [];
  const neighborOffsets = diagonal
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  for (let seed = 0; seed < memberCells.length; seed += 1) {
    if (memberCells[seed] === 0 || labels[seed] !== -1) continue;
    const componentIndex = components.length;
    labels[seed] = componentIndex;
    stack.push(seed);
    let cellCount = 0;
    let valueSum = 0;
    let touchesBoundary = false;
    let weightedEast = 0;
    let weightedNorth = 0;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      const column = cell % width;
      const row = (cell - column) / width;
      const weight = values === null ? 1 : values[cell]!;
      cellCount += 1;
      valueSum += weight;
      if (column === 0 || column === width - 1 || row === 0 || row === height - 1) {
        touchesBoundary = true;
      }
      weightedEast += weight * (originEastM + (column + 0.5) * cellWidthM);
      weightedNorth += weight * (originNorthM + (row + 0.5) * cellHeightM);
      for (const [dc, dr] of neighborOffsets) {
        const nc = column + dc!;
        const nr = row + dr!;
        if (nc < 0 || nc >= width || nr < 0 || nr >= height) continue;
        const next = nr * width + nc;
        if (memberCells[next] === 0 || labels[next] !== -1) continue;
        labels[next] = componentIndex;
        stack.push(next);
      }
    }
    components.push({
      cellCount,
      valueSum,
      touchesBoundary,
      centroidEastM: weightedEast / Math.max(valueSum, Number.MIN_VALUE),
      centroidNorthM: weightedNorth / Math.max(valueSum, Number.MIN_VALUE),
    });
  }
  return { labels, components };
}

// メンバ判定→連結成分を一段で行う口。重みは消散値そのもの。
export function labelFieldComponents(
  plane: CloudFieldPlane,
  memberThreshold: number,
  sense: MemberSense,
  diagonal: boolean,
): LabeledField {
  return labelMaskComponents(
    fieldMemberMask(plane, memberThreshold, sense),
    plane.width, plane.height, plane.cellWidthM, plane.cellHeightM,
    plane.originEastM, plane.originNorthM, plane.values, diagonal,
  );
}

// 値で重み付けした場全体の重心 [m]。値の総和が零なら null。
export function fieldValueCentroid(
  plane: CloudFieldPlane,
): { readonly eastM: number; readonly northM: number } | null {
  requirePlane(plane);
  let valueSum = 0;
  let weightedEast = 0;
  let weightedNorth = 0;
  for (let index = 0; index < plane.values.length; index += 1) {
    const value = plane.values[index]!;
    if (value <= 0) continue;
    const column = index % plane.width;
    const row = (index - column) / plane.width;
    valueSum += value;
    weightedEast += value * (plane.originEastM + (column + 0.5) * plane.cellWidthM);
    weightedNorth += value * (plane.originNorthM + (row + 0.5) * plane.cellHeightM);
  }
  if (valueSum === 0) return null;
  return { eastM: weightedEast / valueSum, northM: weightedNorth / valueSum };
}

// 値で重み付けした二次中心化モーメントから、同じ慣性主軸を持つ等価楕円の
// 半軸と主軸方位を返す。一様楕円板の慣性関係 λ = a²/4 で半軸へ換算する。
// 伸長した形は長半径 ≫ 短半径、等方な形は両者が近い値になる。値の総和が零なら null。
export function fieldMomentAxes(
  plane: CloudFieldPlane,
): {
  readonly majorRadiusM: number;
  readonly minorRadiusM: number;
  readonly majorAxisAzimuthRad: number;
} | null {
  requirePlane(plane);
  const centroid = fieldValueCentroid(plane);
  if (centroid === null) return null;
  let weightSum = 0;
  let momentEastM2 = 0;
  let momentNorthM2 = 0;
  let momentCrossM2 = 0;
  for (const [index, weight] of plane.values.entries()) {
    if (weight <= 0) continue;
    const column = index % plane.width;
    const row = (index - column) / plane.width;
    const eastM = plane.originEastM + (column + 0.5) * plane.cellWidthM - centroid.eastM;
    const northM = plane.originNorthM + (row + 0.5) * plane.cellHeightM - centroid.northM;
    weightSum += weight;
    momentEastM2 += weight * eastM * eastM;
    momentNorthM2 += weight * northM * northM;
    momentCrossM2 += weight * eastM * northM;
  }
  const eastVarianceM2 = momentEastM2 / weightSum;
  const northVarianceM2 = momentNorthM2 / weightSum;
  const crossVarianceM2 = momentCrossM2 / weightSum;
  const meanVarianceM2 = (eastVarianceM2 + northVarianceM2) / 2;
  const spreadM2 = Math.hypot((eastVarianceM2 - northVarianceM2) / 2, crossVarianceM2);
  return {
    majorRadiusM: 2 * Math.sqrt(meanVarianceM2 + spreadM2),
    minorRadiusM: 2 * Math.sqrt(Math.max(meanVarianceM2 - spreadM2, 0)),
    // 対称 2×2 モーメント行列の大固有値の方位。east から north 向き。
    majorAxisAzimuthRad: Math.atan2(2 * crossVarianceM2, eastVarianceM2 - northVarianceM2) / 2,
  };
}

// 成分の面積と同じ面積を持つ円の直径 [m]。
export function equivalentDiameterM(cellCount: number, cellAreaM2: number): number {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0 || !(cellAreaM2 > 0)) {
    throw new RangeError('equivalent diameter requires a positive cell count and cell area');
  }
  return Math.sqrt(4 * cellCount * cellAreaM2 / Math.PI);
}

// 縁に触れない非メンバ成分(穴)の面積率。分子は穴セル、分母は格子の全セル。
export function interiorHoleShare(labeled: LabeledField, totalCellCount: number): {
  readonly interiorShare: number;
  readonly interiorComponentCount: number;
} {
  if (!Number.isSafeInteger(totalCellCount) || totalCellCount <= 0) {
    throw new RangeError('totalCellCount must be a positive integer');
  }
  let interiorCells = 0;
  let interiorComponentCount = 0;
  for (const component of labeled.components) {
    if (component.touchesBoundary) continue;
    interiorCells += component.cellCount;
    interiorComponentCount += 1;
  }
  return { interiorShare: interiorCells / totalCellCount, interiorComponentCount };
}

// 層の mask を整数セルだけずらして重ねた和集合の支持面積 [m2]。
// 層ごとのシフトは投影方向と層高さから呼び出し側が決める。
export function unionShiftedSupportAreaM2(
  layers: readonly {
    readonly plane: CloudFieldPlane;
    readonly shiftEastCells: number;
    readonly shiftNorthCells: number;
    readonly memberThreshold: number;
  }[],
): number {
  if (layers.length === 0) return 0;
  const { width, height, cellWidthM, cellHeightM } = layers[0]!.plane;
  const union = new Uint8Array(width * height);
  for (const layer of layers) {
    const plane = layer.plane;
    if (plane.width !== width || plane.height !== height
      || plane.cellWidthM !== cellWidthM || plane.cellHeightM !== cellHeightM
      || plane.originEastM !== layers[0]!.plane.originEastM
      || plane.originNorthM !== layers[0]!.plane.originNorthM) {
      throw new RangeError('shifted support layers must share one grid');
    }
    for (let row = 0; row < height; row += 1) {
      const sourceRow = row - layer.shiftNorthCells;
      if (sourceRow < 0 || sourceRow >= height) continue;
      for (let column = 0; column < width; column += 1) {
        const sourceColumn = column - layer.shiftEastCells;
        if (sourceColumn < 0 || sourceColumn >= width) continue;
        if (plane.values[sourceRow * width + sourceColumn]! > layer.memberThreshold) {
          union[row * width + column] = 1;
        }
      }
    }
  }
  let supportCells = 0;
  for (const member of union) supportCells += member;
  return supportCells * cellWidthM * cellHeightM;
}

// 時系列の成分存続。連続する二コマの成分を、セル重複が小さい側の面積の
// 半分以上で対応付け、追跡ごとの存続分数を返す。
export function measureComponentPersistence(
  frames: readonly {
    readonly timeMinutes: number;
    readonly memberCells: Uint8Array;
  }[],
  width: number,
  height: number,
  cellWidthM: number,
  cellHeightM: number,
  originEastM: number,
  originNorthM: number,
  diagonal: boolean,
): { readonly durationsMinutes: readonly number[] } {
  if (frames.length === 0) return { durationsMinutes: [] };
  let previous: {
    readonly labels: Int32Array;
    readonly componentCellCounts: readonly number[];
    readonly trackIds: number[];
  } | null = null;
  const trackStarts: number[] = [];
  const trackEnds: number[] = [];
  for (const frame of frames) {
    const labeled = labelMaskComponents(
      frame.memberCells, width, height, cellWidthM, cellHeightM,
      originEastM, originNorthM, null, diagonal,
    );
    const trackIds = new Array<number>(labeled.components.length).fill(-1);
    if (previous === null) {
      for (let index = 0; index < labeled.components.length; index += 1) {
        trackIds[index] = trackStarts.length;
        trackStarts.push(frame.timeMinutes);
        trackEnds.push(frame.timeMinutes);
      }
    } else {
      // セル積から前コマ成分との重複個数を数え、最大のものを同一追跡へつなぐ。
      const overlap = new Map<number, number>();
      for (let cell = 0; cell < labeled.labels.length; cell += 1) {
        const current = labeled.labels[cell]!;
        const prior = previous.labels[cell]!;
        if (current < 0 || prior < 0) continue;
        const key = current * labeled.components.length + prior;
        overlap.set(key, (overlap.get(key) ?? 0) + 1);
      }
      const matchedPrevious = new Set<number>();
      for (let index = 0; index < labeled.components.length; index += 1) {
        let bestPrior = -1;
        let bestOverlap = 0;
        for (const [key, count] of overlap) {
          if (((key / labeled.components.length) | 0) !== index) continue;
          const prior = key % labeled.components.length;
          if (matchedPrevious.has(prior) || count <= bestOverlap) continue;
          bestPrior = prior;
          bestOverlap = count;
        }
        const minimumArea = bestPrior >= 0
          ? Math.min(
            labeled.components[index]!.cellCount,
            previous.componentCellCounts[bestPrior]!,
          )
          : 0;
        if (bestPrior >= 0 && bestOverlap >= 0.5 * minimumArea) {
          trackIds[index] = previous.trackIds[bestPrior]!;
          matchedPrevious.add(bestPrior);
        } else {
          trackIds[index] = trackStarts.length;
          trackStarts.push(frame.timeMinutes);
          trackEnds.push(frame.timeMinutes);
        }
        trackEnds[trackIds[index]!] = frame.timeMinutes;
      }
    }
    previous = {
      labels: labeled.labels,
      componentCellCounts: labeled.components.map((component) => component.cellCount),
      trackIds,
    };
  }
  const durations = trackStarts.map(
    (start, index) => trackEnds[index]! - start,
  );
  return { durationsMinutes: durations };
}

// 焼かれた光学場の一つの層・相を平面へ切り出す。
// 格子の原点・セル寸法は場を張った側の値を渡す。
export function cloudOpticalVolumeLayerPlane(
  data: CloudOpticalVolumeData,
  grid: {
    readonly originEastM: number;
    readonly originNorthM: number;
    readonly cellWidthM: number;
    readonly cellHeightM: number;
  },
  layerIndex: number,
  phase: 'liquid' | 'ice',
): CloudFieldPlane {
  const layerCount = data.layerEdgesM.length - 1;
  if (!Number.isSafeInteger(layerIndex) || layerIndex < 0 || layerIndex >= layerCount) {
    throw new RangeError('layer index must select a baked layer');
  }
  const cellCount = data.width * data.height;
  const source = phase === 'liquid' ? data.liquidExtinctionPerM : data.iceExtinctionPerM;
  return {
    width: data.width,
    height: data.height,
    cellWidthM: grid.cellWidthM,
    cellHeightM: grid.cellHeightM,
    originEastM: grid.originEastM,
    originNorthM: grid.originNorthM,
    values: source.slice(layerIndex * cellCount, (layerIndex + 1) * cellCount),
  };
}

// 焼かれた光学場を厳密セル横断の積分器が読む層リストへ並べ替える。
export function cloudExtinctionLayersFromVolume(
  data: CloudOpticalVolumeData,
): readonly CloudExtinctionLayer[] {
  const cellCount = data.width * data.height;
  return Array.from({ length: data.layerEdgesM.length - 1 }, (_, layerIndex) => ({
    lowerAltitudeM: data.layerEdgesM[layerIndex]!,
    upperAltitudeM: data.layerEdgesM[layerIndex + 1]!,
    liquidPerMByCell: Array.from(
      data.liquidExtinctionPerM.subarray(layerIndex * cellCount, (layerIndex + 1) * cellCount)),
    icePerMByCell: Array.from(
      data.iceExtinctionPerM.subarray(layerIndex * cellCount, (layerIndex + 1) * cellCount)),
  }));
}
