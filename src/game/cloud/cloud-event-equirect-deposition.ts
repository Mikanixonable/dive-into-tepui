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
  accumulateCloudParcelMass,
  depositCloudParcelMass,
  type CloudMassAccumulation,
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

// 堆積の前後で相別質量が一致することを確かめる。additionalToleranceKg は、確かめ方
// 固有の丸めの床(共有累積器の前後差で読む場合の差分の分解能など)を足す許容で、
// 省略時は相対 1e-10 の照合だけを行う。
function validateMassBalance(
  expected: Readonly<Record<CloudMassPhase, number>>,
  actual: Readonly<Record<CloudMassPhase, number>>,
  additionalToleranceKg = 0,
): void {
  requireFinite(additionalToleranceKg, 'additionalToleranceKg');
  if (additionalToleranceKg < 0) {
    throw new RangeError('additionalToleranceKg must be non-negative');
  }
  for (const phase of ['liquid', 'ice'] as const) {
    const targetKg = expected[phase];
    requireFinite(targetKg, `expected ${phase} mass`);
    requireFinite(actual[phase], `deposited ${phase} mass`);
    const toleranceKg = Math.max(Number.MIN_VALUE, Math.abs(targetKg) * 1e-10)
      + additionalToleranceKg;
    if (Math.abs(actual[phase] - targetKg) > toleranceKg) {
      throw new RangeError(`${phase} mass is not conserved by equirect deposition`);
    }
  }
}

// 材料1単位ずつ parcel を組み立てる。液水の親と氷コホートを parcelAt で1件ずつ作り、
// parcel が触れた格子セルの index を併せて返す。堆積と累積が共有する。
function eventMaterialParcels(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  parcelAt: (
    phase: CloudMassPhase,
    massKgM2: number,
    directionUnitVector: Vec3,
    geometricHeightM: number,
    footprintShape: CloudEventFootprintShape,
  ) => CloudMassParcel,
): {
  readonly parcels: readonly CloudMassParcel[];
  readonly touchedCellIndices: readonly number[];
} {
  requirePositive(sourceAreaM2, 'sourceAreaM2');
  validateMaterialMass(material);
  if (material.parent === null && footprintShapes.parentLiquid !== null) {
    throw new RangeError('parentLiquid must be null when no liquid parent exists');
  }
  if (material.parent !== null && footprintShapes.parentLiquid === null) {
    throw new RangeError('parentLiquid is required for a liquid parent');
  }
  const iceFootprintShapes = footprintShapeByCohortIndex(
    material, footprintShapes.releasedIceCohorts);

  const parcels: CloudMassParcel[] = [];
  if (material.parent !== null && footprintShapes.parentLiquid !== null) {
    parcels.push(parcelAt(
      'liquid', material.parent.massKgM2, material.parent.directionUnitVector,
      material.parent.geometricHeightM, footprintShapes.parentLiquid));
  }
  for (const cohort of material.releasedIceCohorts) {
    const footprintShape = iceFootprintShapes.get(cohort.cohortIndex);
    if (footprintShape === undefined) throw new Error('validated ice footprint shape is unavailable');
    parcels.push(parcelAt(
      'ice', cohort.massKgM2, cohort.directionUnitVector, cohort.geometricHeightM,
      footprintShape));
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
  return { parcels, touchedCellIndices };
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
  if (target === undefined) {
    validateCloudEquirectGrid(grid);
    validateMassGrid(grid, massGrid);
  } else if (target.grid !== grid || target.massGrid !== massGrid) {
    throw new RangeError('deposition target must refer to the same grids being deposited into');
  }
  const { parcels, touchedCellIndices } = eventMaterialParcels(
    material, sourceAreaM2, footprintShapes,
    (phase, massKgM2, directionUnitVector, geometricHeightM, footprintShape) =>
      makeParcel(
        phase, massKgM2, directionUnitVector, geometricHeightM, sourceAreaM2,
        footprintShape, grid));
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

// イベント材料を検算済みの宛先へ直接累積する。per-event の堆積配列は作らない —
// parcel の組み立てとセル被覆は戻り値を返す経路と同じで、格子への書き込みだけが
// 供給の永続累積器へ行く。このイベントが載せた質量は、累積値の前後差で照合する。
export function accumulateCloudEventMaterialCohortsEquirect(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  target: CloudEquirectDepositionTarget,
  accumulation: CloudMassAccumulation,
): void {
  if (accumulation.grid !== target.massGrid) {
    throw new RangeError('accumulation must belong to the target mass grid');
  }
  const { parcels, touchedCellIndices } = eventMaterialParcels(
    material, sourceAreaM2, footprintShapes,
    (phase, massKgM2, directionUnitVector, geometricHeightM, footprintShape) =>
      makeParcel(
        phase, massKgM2, directionUnitVector, geometricHeightM, sourceAreaM2,
        footprintShape, target.grid));

  // 累積する前に、触れたセルの値と格子外質量を退避する。共有の累積器には以前の
  // イベントの質量が混ざっているので、前後差を取ってこのイベントぶんを照合する。
  // 退避は footprint が触れたセルぶんだけで、全格子の複写は要らない。
  const layerCount = target.massGrid.layerEdgesM.length - 1;
  const cellCount = target.massGrid.cells.length;
  const touchedCount = touchedCellIndices.length;
  const beforeLiquidKgM2 = new Float64Array(layerCount * touchedCount);
  const beforeIceKgM2 = new Float64Array(layerCount * touchedCount);
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
    const layerBase = layerIndex * cellCount;
    const slotBase = layerIndex * touchedCount;
    for (const [slot, cellIndex] of touchedCellIndices.entries()) {
      beforeLiquidKgM2[slotBase + slot] = accumulation.liquidKgM2[layerBase + cellIndex]!;
      beforeIceKgM2[slotBase + slot] = accumulation.iceKgM2[layerBase + cellIndex]!;
    }
  }
  const unassignedLiquidBeforeKg = accumulation.unassignedMassKgByPhase.liquid;
  const unassignedIceBeforeKg = accumulation.unassignedMassKgByPhase.ice;

  accumulateCloudParcelMass(parcels, accumulation);

  const deposited = {
    liquid: accumulation.unassignedMassKgByPhase.liquid - unassignedLiquidBeforeKg,
    ice: accumulation.unassignedMassKgByPhase.ice - unassignedIceBeforeKg,
  };
  // 前後差の分解能は累積値の絶対丸めで決まる — 読み戻した値の大きさから差分の
  // 誤差上界を積み、照合の許容へ足す。微小なイベントほど相対精度は取れないが、
  // 供給全体の末尾照合が積算ずれを捕える。
  let roundingAllowanceKg = Number.EPSILON * (
    Math.abs(accumulation.unassignedMassKgByPhase.liquid) + Math.abs(unassignedLiquidBeforeKg)
    + Math.abs(accumulation.unassignedMassKgByPhase.ice) + Math.abs(unassignedIceBeforeKg));
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
    const layerBase = layerIndex * cellCount;
    const slotBase = layerIndex * touchedCount;
    for (const [slot, cellIndex] of touchedCellIndices.entries()) {
      const areaM2 = target.massGrid.cells[cellIndex]!.areaM2;
      const liquidAfter = accumulation.liquidKgM2[layerBase + cellIndex]!;
      const iceAfter = accumulation.iceKgM2[layerBase + cellIndex]!;
      deposited.liquid += (liquidAfter - beforeLiquidKgM2[slotBase + slot]!) * areaM2;
      deposited.ice += (iceAfter - beforeIceKgM2[slotBase + slot]!) * areaM2;
      roundingAllowanceKg += Number.EPSILON * Math.max(
        Math.abs(liquidAfter), Math.abs(iceAfter)) * areaM2;
    }
  }
  validateMassBalance(
    expectedMassByPhaseKg(material, sourceAreaM2), deposited, roundingAllowanceKg);
}
