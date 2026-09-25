// 球面上で輸送したイベント材料を、明示面積を用いて地表固定局所格子へ分配する診断adapter。
// supplySourceId の一意性やこのadapterの質量収支は、複数source領域の地理的な非重複を保証しない。
// この関数単体は製品場への接続でも、C1の製品空間質量合格判定でもない。

import { cross, dot, len } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEventMaterialCohorts } from './cloud-event-transport';
import {
  cloudFootprintOverlap,
  type CloudFootprintGrid,
} from './cloud-footprint-overlap';
import {
  depositCloudParcelMass,
  type CloudMassDeposition,
  type CloudMassGrid,
  type CloudMassParcel,
} from './cloud-mass-deposition';

export interface CloudEventFootprintAreas {
  readonly parentLiquidM2: number | null;
  readonly releasedIceCohorts: readonly CloudIceCohortFootprintArea[];
}

export interface CloudIceCohortFootprintArea {
  readonly cohortIndex: number;
  readonly areaM2: number;
}

export interface CloudEventTangentChart {
  readonly centerDirectionUnitVector: Vec3;
  readonly eastUnitVector: Vec3;
  readonly northUnitVector: Vec3;
  readonly sphereRadiusM: number;
  readonly maxAngularDistanceRad: number;
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

function validateChart(chart: CloudEventTangentChart): void {
  validateUnitVector(chart.centerDirectionUnitVector, 'centerDirectionUnitVector');
  validateUnitVector(chart.eastUnitVector, 'eastUnitVector');
  validateUnitVector(chart.northUnitVector, 'northUnitVector');
  requirePositive(chart.sphereRadiusM, 'sphereRadiusM');
  requireFinite(chart.maxAngularDistanceRad, 'maxAngularDistanceRad');
  if (chart.maxAngularDistanceRad <= 0 || chart.maxAngularDistanceRad >= Math.PI / 2) {
    throw new RangeError('maxAngularDistanceRad must be between zero and π/2');
  }
  const center = chart.centerDirectionUnitVector;
  const east = chart.eastUnitVector;
  const north = chart.northUnitVector;
  if (Math.abs(dot(center, east)) > VECTOR_TOLERANCE
    || Math.abs(dot(center, north)) > VECTOR_TOLERANCE
    || Math.abs(dot(east, north)) > VECTOR_TOLERANCE
    || dot(cross(east, north), center) < 1 - VECTOR_TOLERANCE) {
    throw new RangeError('tangent chart basis must be orthogonal and right-handed');
  }
}

function validateLocalGrid(footprintGrid: CloudFootprintGrid, massGrid: CloudMassGrid): void {
  const { originEastM, originNorthM, cellWidthM, cellHeightM, width, height } = footprintGrid;
  for (const [name, value] of Object.entries({ originEastM, originNorthM, cellWidthM, cellHeightM })) {
    requireFinite(value, `footprintGrid.${name}`);
  }
  if (cellWidthM <= 0 || cellHeightM <= 0
    || !Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0
    || !Number.isSafeInteger(width * height)) {
    throw new RangeError('footprint grid dimensions and cell sizes must be positive and finite');
  }
  const rightM = originEastM + width * cellWidthM;
  const topM = originNorthM + height * cellHeightM;
  const rectangleCellAreaM2 = cellWidthM * cellHeightM;
  if (![rightM, topM, rectangleCellAreaM2].every(Number.isFinite) || rectangleCellAreaM2 <= 0) {
    throw new RangeError('footprint grid extents and cell area must be finite and positive');
  }
  if (massGrid.cells.length !== width * height) {
    throw new RangeError('mass grid cells must match the footprint grid dimensions');
  }
  for (const [index, cell] of massGrid.cells.entries()) {
    requirePositive(cell.areaM2, `massGrid.cells[${index}].areaM2`);
    const areaToleranceM2 = 16 * Number.EPSILON * Math.max(cell.areaM2, rectangleCellAreaM2);
    if (Math.abs(cell.areaM2 - rectangleCellAreaM2) > areaToleranceM2) {
      throw new RangeError('mass grid cell area must match the local rectangular footprint grid');
    }
  }
}

function projectToChart(
  directionUnitVector: Vec3,
  geometricHeightM: number,
  footprintAreaM2: number,
  chart: CloudEventTangentChart,
): { readonly eastM: number; readonly northM: number } {
  validateUnitVector(directionUnitVector, 'directionUnitVector');
  requireFinite(geometricHeightM, 'geometricHeightM');
  if (geometricHeightM < 0) throw new RangeError('geometricHeightM must be non-negative');
  requirePositive(footprintAreaM2, 'footprintAreaM2');
  const footprintRadiusM = Math.sqrt(footprintAreaM2 / Math.PI);
  const footprintAngularRadiusRad = footprintRadiusM / chart.sphereRadiusM;
  if (!Number.isFinite(footprintAngularRadiusRad)) {
    throw new RangeError('footprint angular radius must be finite');
  }

  const center = chart.centerDirectionUnitVector;
  const sineAngle = len(cross(center, directionUnitVector));
  const cosineAngle = Math.max(-1, Math.min(1, dot(center, directionUnitVector)));
  const angleRad = Math.atan2(sineAngle, cosineAngle);
  if (angleRad + footprintAngularRadiusRad > chart.maxAngularDistanceRad) {
    throw new RangeError('material footprint extends outside the tangent chart domain');
  }
  if (angleRad === 0) return { eastM: 0, northM: 0 };

  // Log-map distance is fixed to the surface sphere. Altitude selects a vertical layer only.
  const distanceM = chart.sphereRadiusM * angleRad;
  const scale = distanceM / sineAngle;
  const eastM = scale * dot(directionUnitVector, chart.eastUnitVector);
  const northM = scale * dot(directionUnitVector, chart.northUnitVector);
  requireFinite(eastM, 'projected eastM');
  requireFinite(northM, 'projected northM');
  return { eastM, northM };
}

function requireArea(value: number, name: string): void {
  requirePositive(value, name);
}

function makeParcel(
  phase: 'liquid' | 'ice',
  massKgM2: number,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  sourceAreaM2: number,
  footprintAreaM2: number,
  chart: CloudEventTangentChart,
  footprintGrid: CloudFootprintGrid,
): CloudMassParcel {
  requireFinite(massKgM2, 'massKgM2');
  if (massKgM2 < 0) throw new RangeError('massKgM2 must be non-negative');
  requireArea(footprintAreaM2, 'footprintAreaM2');
  const massKg = massKgM2 * sourceAreaM2;
  requireFinite(massKg, 'massKg');
  const center = projectToChart(directionUnitVector, geometricHeightM, footprintAreaM2, chart);
  const coverage = cloudFootprintOverlap({
    ...center,
    radiusM: Math.sqrt(footprintAreaM2 / Math.PI),
  }, footprintGrid);
  return {
    phase,
    massKg,
    altitudeM: geometricHeightM,
    footprintAreaM2: coverage.footprintAreaM2,
    overlaps: coverage.overlaps,
  };
}

function sum(values: readonly number[]): number {
  const accumulator: SumAccumulator = { total: 0, correction: 0 };
  for (const value of values) {
    addCompensated(accumulator, value);
  }
  return accumulator.total;
}

function expectedMassByPhaseKg(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
): Readonly<Record<'liquid' | 'ice', number>> {
  return {
    liquid: (material.parent?.massKgM2 ?? 0) * sourceAreaM2,
    ice: sum(material.releasedIceCohorts.map((cohort) => cohort.massKgM2)) * sourceAreaM2,
  };
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

function footprintAreaByCohortIndex(
  material: CloudEventMaterialCohorts,
  footprints: readonly CloudIceCohortFootprintArea[],
): ReadonlyMap<number, number> {
  if (footprints.length !== material.releasedIceCohorts.length) {
    throw new RangeError('each released ice cohort requires one explicit footprint area');
  }
  const areas = new Map<number, number>();
  for (const footprint of footprints) {
    if (!Number.isInteger(footprint.cohortIndex) || footprint.cohortIndex < 0) {
      throw new RangeError('footprint cohortIndex must be a non-negative integer');
    }
    requireArea(footprint.areaM2, 'released ice footprint areaM2');
    if (areas.has(footprint.cohortIndex)) {
      throw new RangeError('duplicate released ice cohort footprint');
    }
    areas.set(footprint.cohortIndex, footprint.areaM2);
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
    if (!areas.has(cohort.cohortIndex)) {
      throw new RangeError(`missing footprint area for ice cohort ${cohort.cohortIndex}`);
    }
  }
  if (areas.size !== cohortIndices.size) throw new RangeError('footprint area refers to an unknown ice cohort');
  return areas;
}

function depositedMassKgByPhase(
  deposition: CloudMassDeposition,
  grid: CloudMassGrid,
): Readonly<Record<'liquid' | 'ice', number>> {
  const liquid: SumAccumulator = { total: 0, correction: 0 };
  const ice: SumAccumulator = { total: 0, correction: 0 };
  for (const layer of deposition.columnsByLayer) {
    for (let index = 0; index < grid.cells.length; index += 1) {
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
  expected: Readonly<Record<'liquid' | 'ice', number>>,
  actual: Readonly<Record<'liquid' | 'ice', number>>,
): void {
  for (const phase of ['liquid', 'ice'] as const) {
    const targetKg = expected[phase];
    requireFinite(targetKg, `expected ${phase} mass`);
    requireFinite(actual[phase], `deposited ${phase} mass`);
    const toleranceKg = Math.max(Number.MIN_VALUE, Math.abs(targetKg) * 1e-10);
    if (Math.abs(actual[phase] - targetKg) > toleranceKg) {
      throw new RangeError(`${phase} mass is not conserved by local deposition`);
    }
  }
}

// イベントの surrogate kg/m² に明示 source area を掛け、材料ごとの明示 footprint で局所格子へ置く。
export function depositCloudEventMaterialCohorts(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintAreas: CloudEventFootprintAreas,
  chart: CloudEventTangentChart,
  footprintGrid: CloudFootprintGrid,
  massGrid: CloudMassGrid,
): CloudMassDeposition {
  requireArea(sourceAreaM2, 'sourceAreaM2');
  validateMaterialMass(material);
  validateChart(chart);
  validateLocalGrid(footprintGrid, massGrid);
  if (material.parent === null && footprintAreas.parentLiquidM2 !== null) {
    throw new RangeError('parentLiquidM2 must be null when no liquid parent exists');
  }
  if (material.parent !== null && footprintAreas.parentLiquidM2 === null) {
    throw new RangeError('parentLiquidM2 is required for a liquid parent');
  }
  const iceFootprintAreasM2 = footprintAreaByCohortIndex(material, footprintAreas.releasedIceCohorts);

  const parcels: CloudMassParcel[] = [];
  if (material.parent !== null && footprintAreas.parentLiquidM2 !== null) {
    parcels.push(makeParcel(
      'liquid', material.parent.massKgM2, material.parent.directionUnitVector,
      material.parent.geometricHeightM, sourceAreaM2, footprintAreas.parentLiquidM2, chart, footprintGrid,
    ));
  }
  for (const cohort of material.releasedIceCohorts) {
    const footprintAreaM2 = iceFootprintAreasM2.get(cohort.cohortIndex);
    if (footprintAreaM2 === undefined) throw new Error('validated ice footprint area is unavailable');
    parcels.push(makeParcel(
      'ice', cohort.massKgM2, cohort.directionUnitVector, cohort.geometricHeightM,
      sourceAreaM2, footprintAreaM2, chart, footprintGrid,
    ));
  }

  const deposition = depositCloudParcelMass(parcels, massGrid);
  validateMassBalance(
    expectedMassByPhaseKg(material, sourceAreaM2),
    depositedMassKgByPhase(deposition, massGrid),
  );
  return deposition;
}
