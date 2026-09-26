// 有限面積 parcel の質量を液水・氷と高度層を保って雲格子へ分配する。

export type CloudMassPhase = 'liquid' | 'ice';

export interface CloudMassParcelOverlap {
  readonly cellIndex: number;
  readonly areaM2: number;
}

export interface CloudMassParcel {
  readonly phase: CloudMassPhase;
  readonly massKg: number;
  readonly altitudeM: number;
  readonly footprintAreaM2: number;
  readonly overlaps: readonly CloudMassParcelOverlap[];
}

export interface CloudMassGridCell {
  readonly areaM2: number;
}

export interface CloudMassGrid {
  readonly cells: readonly CloudMassGridCell[];
  readonly layerEdgesM: readonly number[];
}

export interface CloudMassLayerColumns {
  readonly lowerAltitudeM: number;
  readonly upperAltitudeM: number;
  readonly liquidKgM2ByCell: readonly number[];
  readonly iceKgM2ByCell: readonly number[];
}

export interface CloudMassDeposition {
  readonly columnsByLayer: readonly CloudMassLayerColumns[];
  readonly unassignedMassKgByPhase: Readonly<Record<CloudMassPhase, number>>;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

// 面積総和の丸め誤差を抑える。
function sumOverlapAreaM2(overlaps: readonly CloudMassParcelOverlap[]): number {
  let total = 0;
  let correction = 0;
  for (const overlap of overlaps) {
    const adjusted = overlap.areaM2 - correction;
    const next = total + adjusted;
    correction = (next - total) - adjusted;
    total = next;
  }
  if (!Number.isFinite(total)) throw new RangeError('overlap area total must be finite');
  return total;
}

// 面積の加算・比較に生じる double 精度の丸め幅を返す。
function areaRoundingToleranceM2(leftM2: number, rightM2: number, operationCount: number): number {
  return Number.EPSILON * Math.max(Math.abs(leftM2), Math.abs(rightM2)) * (operationCount + 1);
}

// 格子の面積と高度層の境界を検証する。
function validateGrid(grid: CloudMassGrid): void {
  if (grid.layerEdgesM.length < 2) throw new RangeError('layerEdgesM must contain at least two boundaries');
  for (const [index, edgeM] of grid.layerEdgesM.entries()) {
    requireFinite(edgeM, `layerEdgesM[${index}]`);
    if (edgeM < 0) throw new RangeError(`layerEdgesM[${index}] must be non-negative`);
    if (index > 0 && edgeM <= grid.layerEdgesM[index - 1]!) {
      throw new RangeError('layerEdgesM must be strictly increasing');
    }
  }
  for (const [index, cell] of grid.cells.entries()) {
    requireFinite(cell.areaM2, `cells[${index}].areaM2`);
    if (cell.areaM2 <= 0) throw new RangeError(`cells[${index}].areaM2 must be positive`);
  }
}

// 高度層は下端を含み、内部境界は上側の層へ割り当てる。
function layerIndexAt(altitudeM: number, edgesM: readonly number[]): number {
  requireFinite(altitudeM, 'altitudeM');
  if (altitudeM < edgesM[0]! || altitudeM > edgesM.at(-1)!) {
    throw new RangeError('parcel altitude is outside the grid layers');
  }
  for (let index = 0; index < edgesM.length - 1; index += 1) {
    if (altitudeM < edgesM[index + 1]!) return index;
  }
  return edgesM.length - 2;
}

// Parcel の相・量・高度・footprint とセル重複面積を検証する。
function validateParcel(parcel: CloudMassParcel, grid: CloudMassGrid): number {
  if (parcel.phase !== 'liquid' && parcel.phase !== 'ice') {
    throw new RangeError('phase must be liquid or ice');
  }
  requireNonNegative(parcel.massKg, 'massKg');
  requireNonNegative(parcel.altitudeM, 'altitudeM');
  requireFinite(parcel.footprintAreaM2, 'footprintAreaM2');
  if (parcel.footprintAreaM2 <= 0) throw new RangeError('footprintAreaM2 must be positive');

  const layerIndex = layerIndexAt(parcel.altitudeM, grid.layerEdgesM);
  const cellIndices = new Set<number>();
  for (const overlap of parcel.overlaps) {
    if (!Number.isInteger(overlap.cellIndex) || overlap.cellIndex < 0 || overlap.cellIndex >= grid.cells.length) {
      throw new RangeError('overlap cellIndex must refer to a grid cell');
    }
    if (cellIndices.has(overlap.cellIndex)) throw new RangeError('parcel overlaps contain a duplicate cellIndex');
    cellIndices.add(overlap.cellIndex);
    requireNonNegative(overlap.areaM2, 'overlap areaM2');
    const cellAreaM2 = grid.cells[overlap.cellIndex]!.areaM2;
    if (overlap.areaM2 - cellAreaM2
      > areaRoundingToleranceM2(overlap.areaM2, cellAreaM2, 1)) {
      throw new RangeError('overlap areaM2 must not exceed its cell area');
    }
  }
  const overlapAreaM2 = sumOverlapAreaM2(parcel.overlaps);
  if (overlapAreaM2 - parcel.footprintAreaM2
    > areaRoundingToleranceM2(overlapAreaM2, parcel.footprintAreaM2, parcel.overlaps.length)) {
    throw new RangeError('overlap area total must not exceed footprintAreaM2');
  }
  return layerIndex;
}

// Overlap 面積比を列密度へ加え、格子へ割り当たらない質量を相別に積む。
function addParcel(
  parcel: CloudMassParcel,
  layerIndex: number,
  columnsByLayer: { liquid: number[][]; ice: number[][] },
  cells: readonly CloudMassGridCell[],
  unassignedMassKgByPhase: Record<CloudMassPhase, number>,
): void {
  const phaseColumns = columnsByLayer[parcel.phase][layerIndex]!;
  for (const overlap of parcel.overlaps) {
    const cell = cells[overlap.cellIndex]!;
    const columnKgM2 = parcel.massKg * overlap.areaM2 / parcel.footprintAreaM2 / cell.areaM2;
    const nextColumnKgM2 = phaseColumns[overlap.cellIndex]! + columnKgM2;
    if (!Number.isFinite(columnKgM2) || !Number.isFinite(nextColumnKgM2)) {
      throw new RangeError('deposited column mass must be finite');
    }
    phaseColumns[overlap.cellIndex] = nextColumnKgM2;
  }
  const overlapAreaM2 = sumOverlapAreaM2(parcel.overlaps);
  // 誤差幅内の完全被覆だけ、丸めで負になる未割当を0へ戻す。
  const uncoveredFraction = Math.max(0, 1 - overlapAreaM2 / parcel.footprintAreaM2);
  const unassignedMassKg = parcel.massKg * uncoveredFraction;
  const nextUnassignedMassKg = unassignedMassKgByPhase[parcel.phase] + unassignedMassKg;
  if (!Number.isFinite(unassignedMassKg) || !Number.isFinite(nextUnassignedMassKg)) {
    throw new RangeError('unassigned mass must be finite');
  }
  unassignedMassKgByPhase[parcel.phase] = nextUnassignedMassKg;
}

// Parcel の有限面積 overlap を高度層・水相別の kg/m² 列へ加算し、格子外質量を返す。
export function depositCloudParcelMass(
  parcels: readonly CloudMassParcel[],
  grid: CloudMassGrid,
): CloudMassDeposition {
  validateGrid(grid);
  const layerCount = grid.layerEdgesM.length - 1;
  const columnsByLayer = {
    liquid: Array.from({ length: layerCount }, () => Array<number>(grid.cells.length).fill(0)),
    ice: Array.from({ length: layerCount }, () => Array<number>(grid.cells.length).fill(0)),
  };
  const unassignedMassKgByPhase: Record<CloudMassPhase, number> = { liquid: 0, ice: 0 };
  for (const parcel of parcels) {
    const layerIndex = validateParcel(parcel, grid);
    addParcel(parcel, layerIndex, columnsByLayer, grid.cells, unassignedMassKgByPhase);
  }
  return {
    columnsByLayer: grid.layerEdgesM.slice(0, -1).map((lowerAltitudeM, index) => ({
      lowerAltitudeM,
      upperAltitudeM: grid.layerEdgesM[index + 1]!,
      liquidKgM2ByCell: columnsByLayer.liquid[index]!,
      iceKgM2ByCell: columnsByLayer.ice[index]!,
    })),
    unassignedMassKgByPhase,
  };
}
