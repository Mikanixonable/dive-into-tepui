// 球面上を輸送したイベント材料を、明示した source 面積と footprint 形状で
// 全球の正距円筒格子へ分配する診断adapter。
// supplySourceId の一意性やこのadapterの質量収支は、複数source領域の地理的な非重複を保証しない。

import { dot, len } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEventMaterialCohorts } from './cloud-event-transport';
import type {
  CloudEventFootprintShape,
  CloudEventFootprintShapes,
  CloudIceCohortFootprintShape,
} from './cloud-event-local-deposition';
import {
  cloudEquirectCellAreaM2,
  cloudEquirectFootprintOverlap,
  cloudEquirectTangentBasisAt,
  validateCloudEquirectGrid,
  type CloudEquirectGrid,
} from './cloud-equirect-grid';
import type { CloudFootprintEllipse } from './cloud-footprint-overlap';
import {
  depositCloudParcelMass,
  type CloudMassDeposition,
  type CloudMassGrid,
  type CloudMassParcel,
  type CloudMassPhase,
} from './cloud-mass-deposition';

// 全球格子と質量格子の面積整合を照合済みの堆積先。
// prepareCloudEquirectDepositionTarget で組み、連続する堆積へ同じものを渡すと、
// イベントごとの格子検証を供給全体で1回へ畳める。
export interface CloudEquirectDepositionTarget {
  readonly grid: CloudEquirectGrid;
  readonly massGrid: CloudMassGrid;
}

// イベントが質量を載せたセルの行優先 index を添えた堆積結果。畳み込み側は格子全体を
// 走らずに触れたセルだけを読めばよい。
export interface CloudEventEquirectDeposition extends CloudMassDeposition {
  readonly touchedCellIndices: readonly number[];
}

const VECTOR_TOLERANCE = 1e-10;

interface SumAccumulator {
  total: number;
  correction: number;
}

function addCompensated(accumulator: SumAccumulator, value: number): void {
  const adjusted = value - accumulator.correction;
  const next = accumulator.total + adjusted;
  accumulator.correction = (next - accumulator.total) - adjusted;
  accumulator.total = next;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function validateUnitVector(vector: Vec3, name: string): void {
  requireFinite(vector.x, `${name}.x`);
  requireFinite(vector.y, `${name}.y`);
  requireFinite(vector.z, `${name}.z`);
  if (Math.abs(len(vector) - 1) > VECTOR_TOLERANCE) {
    throw new RangeError(`${name} must be a unit vector`);
  }
}

function sum(values: readonly number[]): number {
  const accumulator: SumAccumulator = { total: 0, correction: 0 };
  for (const value of values) {
    addCompensated(accumulator, value);
  }
  return accumulator.total;
}

function validateMaterialMass(material: CloudEventMaterialCohorts): void {
  requireFinite(material.totalMassKgM2, 'totalMassKgM2');
  if (material.totalMassKgM2 < 0) throw new RangeError('totalMassKgM2 must be non-negative');
  const parentMassKgM2 = material.parent?.massKgM2 ?? 0;
  const cohortMassKgM2 = sum(material.releasedIceCohorts.map((cohort) => cohort.massKgM2));
  const componentMassKgM2 = parentMassKgM2 + cohortMassKgM2;
  const toleranceKgM2 = Math.max(Number.MIN_VALUE, Math.abs(componentMassKgM2) * 1e-10);
  if (!Number.isFinite(componentMassKgM2)
    || Math.abs(componentMassKgM2 - material.totalMassKgM2) > toleranceKgM2) {
    throw new RangeError('material totalMassKgM2 must equal its liquid and ice components');
  }
}

// 材料1単位の footprint 形を、材料方向の接平面基底に落として楕円へ変換する。
// G = c²I + Σvvᵀ の固有値を半軸、固有ベクトルを主軸方位とする。
function footprintEllipseAtBasis(
  shape: CloudEventFootprintShape,
  eastUnitVector: Vec3,
  northUnitVector: Vec3,
): {
  readonly majorRadiusM: number;
  readonly minorRadiusM: number;
  readonly majorAxisAzimuthRad: number;
} {
  requirePositive(shape.isotropicRadiusM, 'footprint isotropicRadiusM');
  const isotropicSquaredM2 = shape.isotropicRadiusM * shape.isotropicRadiusM;
  let g11 = isotropicSquaredM2;
  let g12 = 0;
  let g22 = isotropicSquaredM2;
  for (const vector of shape.elongationVectorsM) {
    requireFinite(vector.x, 'elongation.x');
    requireFinite(vector.y, 'elongation.y');
    requireFinite(vector.z, 'elongation.z');
    const eastM = dot(vector, eastUnitVector);
    const northM = dot(vector, northUnitVector);
    g11 += eastM * eastM;
    g12 += eastM * northM;
    g22 += northM * northM;
  }
  const traceHalfM2 = (g11 + g22) / 2;
  const offDiagonalRadiusM2 = Math.hypot((g11 - g22) / 2, g12);
  return {
    majorRadiusM: Math.sqrt(traceHalfM2 + offDiagonalRadiusM2),
    minorRadiusM: Math.sqrt(
      Math.max(traceHalfM2 - offDiagonalRadiusM2, Number.MIN_VALUE)),
    // 対称 2×2 の大固有値の主軸方位。等方では不定だが、そのとき半軸が等しく方位は結果に効かない。
    majorAxisAzimuthRad: Math.atan2(2 * g12, g11 - g22) / 2,
  };
}

// 質量格子が全球格子の実セル面積と一致することを検証する。
function validateMassGrid(grid: CloudEquirectGrid, massGrid: CloudMassGrid): void {
  if (massGrid.cells.length !== grid.width * grid.height) {
    throw new RangeError('mass grid cells must match the equirect grid dimensions');
  }
  for (const [index, cell] of massGrid.cells.entries()) {
    const expectedAreaM2 = cloudEquirectCellAreaM2(grid, Math.floor(index / grid.width));
    const toleranceM2 = 16 * Number.EPSILON * Math.max(cell.areaM2, expectedAreaM2);
    if (!Number.isFinite(cell.areaM2) || cell.areaM2 <= 0
      || Math.abs(cell.areaM2 - expectedAreaM2) > toleranceM2) {
      throw new RangeError('mass grid cell area must match the equirect band area');
    }
  }
}

// 格子の寸法と質量格子のセル面積が全球格子の実面積と一致することを1回だけ確かめ、
// 照合済みの堆積先として返す。
export function prepareCloudEquirectDepositionTarget(
  grid: CloudEquirectGrid,
  massGrid: CloudMassGrid,
): CloudEquirectDepositionTarget {
  validateCloudEquirectGrid(grid);
  validateMassGrid(grid, massGrid);
  return { grid, massGrid };
}

function makeParcel(
  phase: CloudMassPhase,
  massKgM2: number,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  sourceAreaM2: number,
  footprintShape: CloudEventFootprintShape,
  grid: CloudEquirectGrid,
): CloudMassParcel {
  requireFinite(massKgM2, 'massKgM2');
  if (massKgM2 < 0) throw new RangeError('massKgM2 must be non-negative');
  validateUnitVector(directionUnitVector, 'directionUnitVector');
  requireFinite(geometricHeightM, 'geometricHeightM');
  if (geometricHeightM < 0) throw new RangeError('geometricHeightM must be non-negative');
  const massKg = massKgM2 * sourceAreaM2;
  requireFinite(massKg, 'massKg');
  const { eastUnitVector, northUnitVector } = cloudEquirectTangentBasisAt(directionUnitVector);
  const ellipse = footprintEllipseAtBasis(footprintShape, eastUnitVector, northUnitVector);
  const footprint: CloudFootprintEllipse = { eastM: 0, northM: 0, ...ellipse };
  const coverage = cloudEquirectFootprintOverlap(directionUnitVector, footprint, grid);
  return {
    phase,
    massKg,
    altitudeM: geometricHeightM,
    footprintAreaM2: coverage.footprintAreaM2,
    overlaps: coverage.overlaps,
  };
}

function footprintShapeByCohortIndex(
  material: CloudEventMaterialCohorts,
  footprints: readonly CloudIceCohortFootprintShape[],
): ReadonlyMap<number, CloudEventFootprintShape> {
  if (footprints.length !== material.releasedIceCohorts.length) {
    throw new RangeError('each released ice cohort requires one explicit footprint shape');
  }
  const shapes = new Map<number, CloudEventFootprintShape>();
  for (const footprint of footprints) {
    if (!Number.isInteger(footprint.cohortIndex) || footprint.cohortIndex < 0) {
      throw new RangeError('footprint cohortIndex must be a non-negative integer');
    }
    if (shapes.has(footprint.cohortIndex)) {
      throw new RangeError('duplicate released ice cohort footprint');
    }
    shapes.set(footprint.cohortIndex, footprint.shape);
  }
  const cohortIndices = new Set<number>();
  for (const cohort of material.releasedIceCohorts) {
    if (!Number.isInteger(cohort.cohortIndex) || cohort.cohortIndex < 0) {
      throw new RangeError('released ice cohortIndex must be a non-negative integer');
    }
    if (cohortIndices.has(cohort.cohortIndex)) {
      throw new RangeError('released ice cohortIndex values must be unique');
    }
    cohortIndices.add(cohort.cohortIndex);
    if (!shapes.has(cohort.cohortIndex)) {
      throw new RangeError(`missing footprint shape for ice cohort ${cohort.cohortIndex}`);
    }
  }
  if (shapes.size !== cohortIndices.size) throw new RangeError('footprint shape refers to an unknown ice cohort');
  return shapes;
}

function expectedMassByPhaseKg(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
): Readonly<Record<CloudMassPhase, number>> {
  return {
    liquid: (material.parent?.massKgM2 ?? 0) * sourceAreaM2,
    ice: sum(material.releasedIceCohorts.map((cohort) => cohort.massKgM2)) * sourceAreaM2,
  };
}

// 質量が載るのは parcel の footprint が触れたセルだけなので、堆積質量の照合は
// そのセルだけで行う — 触れていないセルは堆積の組み立て方から値を持たない。
function depositedMassKgByPhase(
  deposition: CloudMassDeposition,
  grid: CloudMassGrid,
  touchedCellIndices: readonly number[],
): Readonly<Record<CloudMassPhase, number>> {
  const liquid: SumAccumulator = { total: 0, correction: 0 };
  const ice: SumAccumulator = { total: 0, correction: 0 };
  for (const layer of deposition.columnsByLayer) {
    for (const index of touchedCellIndices) {
      const cellAreaM2 = grid.cells[index]!.areaM2;
      addCompensated(liquid, layer.liquidKgM2ByCell[index]! * cellAreaM2);
      addCompensated(ice, layer.iceKgM2ByCell[index]! * cellAreaM2);
    }
  }
  addCompensated(liquid, deposition.unassignedMassKgByPhase.liquid);
  addCompensated(ice, deposition.unassignedMassKgByPhase.ice);
  return { liquid: liquid.total, ice: ice.total };
}

function validateMassBalance(
  expected: Readonly<Record<CloudMassPhase, number>>,
  actual: Readonly<Record<CloudMassPhase, number>>,
): void {
  for (const phase of ['liquid', 'ice'] as const) {
    const targetKg = expected[phase];
    requireFinite(targetKg, `expected ${phase} mass`);
    requireFinite(actual[phase], `deposited ${phase} mass`);
    const toleranceKg = Math.max(Number.MIN_VALUE, Math.abs(targetKg) * 1e-10);
    if (Math.abs(actual[phase] - targetKg) > toleranceKg) {
      throw new RangeError(`${phase} mass is not conserved by equirect deposition`);
    }
  }
}

// イベントの surrogate kg/m² に明示 source area を掛け、材料ごとの明示 footprint 形状で
// 全球の正距円筒格子へ置く。格子へ割り当たらなかった分は未分配質量として返る。
// target へ照合済みの堆積先を渡すと格子検証を省く — 別の格子の組を渡すと投げる。
export function depositCloudEventMaterialCohortsEquirect(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  grid: CloudEquirectGrid,
  massGrid: CloudMassGrid,
  target?: CloudEquirectDepositionTarget,
): CloudEventEquirectDeposition {
  requirePositive(sourceAreaM2, 'sourceAreaM2');
  validateMaterialMass(material);
  if (target === undefined) {
    validateCloudEquirectGrid(grid);
    validateMassGrid(grid, massGrid);
  } else if (target.grid !== grid || target.massGrid !== massGrid) {
    throw new RangeError('deposition target must refer to the same grids being deposited into');
  }
  if (material.parent === null && footprintShapes.parentLiquid !== null) {
    throw new RangeError('parentLiquid must be null when no liquid parent exists');
  }
  if (material.parent !== null && footprintShapes.parentLiquid === null) {
    throw new RangeError('parentLiquid is required for a liquid parent');
  }
  const iceFootprintShapes = footprintShapeByCohortIndex(material, footprintShapes.releasedIceCohorts);

  const parcels: CloudMassParcel[] = [];
  if (material.parent !== null && footprintShapes.parentLiquid !== null) {
    parcels.push(makeParcel(
      'liquid', material.parent.massKgM2, material.parent.directionUnitVector,
      material.parent.geometricHeightM, sourceAreaM2, footprintShapes.parentLiquid, grid,
    ));
  }
  for (const cohort of material.releasedIceCohorts) {
    const footprintShape = iceFootprintShapes.get(cohort.cohortIndex);
    if (footprintShape === undefined) throw new Error('validated ice footprint shape is unavailable');
    parcels.push(makeParcel(
      'ice', cohort.massKgM2, cohort.directionUnitVector, cohort.geometricHeightM,
      sourceAreaM2, footprintShape, grid,
    ));
  }

  const touchedCellIndices: number[] = [];
  const touched = new Set<number>();
  for (const parcel of parcels) {
    for (const overlap of parcel.overlaps) {
      if (!touched.has(overlap.cellIndex)) {
        touched.add(overlap.cellIndex);
        touchedCellIndices.push(overlap.cellIndex);
      }
    }
  }
  const deposition = depositCloudParcelMass(parcels, massGrid);
  validateMassBalance(
    expectedMassByPhaseKg(material, sourceAreaM2),
    depositedMassKgByPhase(deposition, massGrid, touchedCellIndices),
  );
  return {
    columnsByLayer: deposition.columnsByLayer,
    unassignedMassKgByPhase: deposition.unassignedMassKgByPhase,
    touchedCellIndices,
  };
}
