// 球面上で輸送したイベント材料を、明示した source 面積と footprint 形状で
// 地表固定局所格子へ分配する診断adapter。
// supplySourceId の一意性やこのadapterの質量収支は、複数source領域の地理的な非重複を保証しない。
// この関数単体は製品場への接続でも、C1の製品空間質量合格判定でもない。

import { cross, dot, len } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEventMaterialCohorts } from './cloud-event-transport';
import {
  cloudFootprintOverlap,
  type CloudFootprintEllipse,
  type CloudFootprintGrid,
} from './cloud-footprint-overlap';
import {
  depositCloudParcelMass,
  type CloudMassDeposition,
  type CloudMassGrid,
  type CloudMassParcel,
} from './cloud-mass-deposition';

// 材料1単位の footprint 形。等方半径と接空間上の伸長ベクトルの組で、
// 接平面上の楕円は G = c²I + Σvvᵀ の固有値・固有ベクトルから復元する。
// 伸長が無い形は等半径の円。
export interface CloudEventFootprintShape {
  // 等方成分の半径。m。
  readonly isotropicRadiusM: number;
  // 伸長成分。長さが伸長距離 [m] のベクトルで、材料の位置の接平面方向へ伸びる。
  readonly elongationVectorsM: readonly Vec3[];
}

export interface CloudEventFootprintShapes {
  readonly parentLiquid: CloudEventFootprintShape | null;
  readonly releasedIceCohorts: readonly CloudIceCohortFootprintShape[];
}

export interface CloudIceCohortFootprintShape {
  readonly cohortIndex: number;
  readonly shape: CloudEventFootprintShape;
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

// footprint の等方半径と伸長ベクトルから、chart 平面上の楕円へ変換する。
// 伸長ベクトルは ECI 接空間のまま運ばれるので、chart の東・北基底へ落として
// 2×2 形状行列 G = c²I + Σvvᵀ を組み、その固有値を半軸、固有ベクトルを主軸方位とする。
// 材料方向と chart 中心が離れるほど基底のずれで形状が歪む近似を含む。
function footprintEllipseFromShape(
  shape: CloudEventFootprintShape,
  chart: CloudEventTangentChart,
): { readonly majorRadiusM: number; readonly minorRadiusM: number; readonly majorAxisAzimuthRad: number } {
  requirePositive(shape.isotropicRadiusM, 'footprint isotropicRadiusM');
  const isotropicSquaredM2 = shape.isotropicRadiusM * shape.isotropicRadiusM;
  let g11 = isotropicSquaredM2;
  let g12 = 0;
  let g22 = isotropicSquaredM2;
  for (const vector of shape.elongationVectorsM) {
    requireFinite(vector.x, 'elongation.x');
    requireFinite(vector.y, 'elongation.y');
    requireFinite(vector.z, 'elongation.z');
    const eastM = dot(vector, chart.eastUnitVector);
    const northM = dot(vector, chart.northUnitVector);
    g11 += eastM * eastM;
    g12 += eastM * northM;
    g22 += northM * northM;
  }
  const traceHalfM2 = (g11 + g22) / 2;
  const offDiagonalRadiusM2 = Math.hypot((g11 - g22) / 2, g12);
  const majorSquaredM2 = traceHalfM2 + offDiagonalRadiusM2;
  const minorSquaredM2 = Math.max(traceHalfM2 - offDiagonalRadiusM2, Number.MIN_VALUE);
  return {
    majorRadiusM: Math.sqrt(majorSquaredM2),
    minorRadiusM: Math.sqrt(minorSquaredM2),
    // 対称 2×2 の大固有値の主軸方位。等方(g12=0 かつ g11=g22)では不定だが、
    // そのとき半軸が等しく方位は結果に効かない。
    majorAxisAzimuthRad: Math.atan2(2 * g12, g11 - g22) / 2,
  };
}

function projectToChart(
  directionUnitVector: Vec3,
  geometricHeightM: number,
  footprintMajorRadiusM: number,
  chart: CloudEventTangentChart,
): { readonly eastM: number; readonly northM: number } {
  validateUnitVector(directionUnitVector, 'directionUnitVector');
  requireFinite(geometricHeightM, 'geometricHeightM');
  if (geometricHeightM < 0) throw new RangeError('geometricHeightM must be non-negative');
  requirePositive(footprintMajorRadiusM, 'footprintMajorRadiusM');
  const footprintAngularRadiusRad = footprintMajorRadiusM / chart.sphereRadiusM;
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

function makeParcel(
  phase: 'liquid' | 'ice',
  massKgM2: number,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  sourceAreaM2: number,
  footprintShape: CloudEventFootprintShape,
  chart: CloudEventTangentChart,
  footprintGrid: CloudFootprintGrid,
): CloudMassParcel {
  requireFinite(massKgM2, 'massKgM2');
  if (massKgM2 < 0) throw new RangeError('massKgM2 must be non-negative');
  const massKg = massKgM2 * sourceAreaM2;
  requireFinite(massKg, 'massKg');
  const ellipse = footprintEllipseFromShape(footprintShape, chart);
  const center = projectToChart(
    directionUnitVector, geometricHeightM, ellipse.majorRadiusM, chart);
  const footprint: CloudFootprintEllipse = {
    ...center,
    majorRadiusM: ellipse.majorRadiusM,
    minorRadiusM: ellipse.minorRadiusM,
    majorAxisAzimuthRad: ellipse.majorAxisAzimuthRad,
  };
  const coverage = cloudFootprintOverlap(footprint, footprintGrid);
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

// イベントの surrogate kg/m² に明示 source area を掛け、材料ごとの明示 footprint 形状で局所格子へ置く。
export function depositCloudEventMaterialCohorts(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  chart: CloudEventTangentChart,
  footprintGrid: CloudFootprintGrid,
  massGrid: CloudMassGrid,
): CloudMassDeposition {
  requirePositive(sourceAreaM2, 'sourceAreaM2');
  validateMaterialMass(material);
  validateChart(chart);
  validateLocalGrid(footprintGrid, massGrid);
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
      material.parent.geometricHeightM, sourceAreaM2, footprintShapes.parentLiquid, chart, footprintGrid,
    ));
  }
  for (const cohort of material.releasedIceCohorts) {
    const footprintShape = iceFootprintShapes.get(cohort.cohortIndex);
    if (footprintShape === undefined) throw new Error('validated ice footprint shape is unavailable');
    parcels.push(makeParcel(
      'ice', cohort.massKgM2, cohort.directionUnitVector, cohort.geometricHeightM,
      sourceAreaM2, footprintShape, chart, footprintGrid,
    ));
  }

  const deposition = depositCloudParcelMass(parcels, massGrid);
  validateMassBalance(
    expectedMassByPhaseKg(material, sourceAreaM2),
    depositedMassKgByPhase(deposition, massGrid),
  );
  return deposition;
}
