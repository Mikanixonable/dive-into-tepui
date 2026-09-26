// 球面上で輸送したイベント材料を、明示した source 面積と footprint 形状で
// 地表固定局所格子へ分配する診断adapter。
// supplySourceId の一意性やこのadapterの質量収支は、複数source領域の地理的な非重複を保証しない。
// この関数単体は製品場への接続でも、C1の製品空間質量合格判定でもない。

import { cross, dot, len } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEventMaterialCohorts } from './cloud-event-transport';
import {
  cloudEventMaterialParcels,
  depositedMassKgByPhase,
  expectedMaterialMassByPhaseKg,
  footprintEllipseAtBasis,
  validateDepositedMassBalance,
  type CloudEventFootprintShape,
  type CloudEventFootprintShapes,
} from './cloud-event-deposition';
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
  type CloudMassPhase,
} from './cloud-mass-deposition';

export interface CloudEventTangentChart {
  readonly centerDirectionUnitVector: Vec3;
  readonly eastUnitVector: Vec3;
  readonly northUnitVector: Vec3;
  readonly sphereRadiusM: number;
  readonly maxAngularDistanceRad: number;
}

const VECTOR_TOLERANCE = 1e-10;

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

  // log-map の距離は地表の球で測る。高度は鉛直の層を選ぶだけで水平位置へ寄与しない。
  const distanceM = chart.sphereRadiusM * angleRad;
  const scale = distanceM / sineAngle;
  const eastM = scale * dot(directionUnitVector, chart.eastUnitVector);
  const northM = scale * dot(directionUnitVector, chart.northUnitVector);
  requireFinite(eastM, 'projected eastM');
  requireFinite(northM, 'projected northM');
  return { eastM, northM };
}

function makeParcel(
  phase: CloudMassPhase,
  massKgM2: number,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  footprintShape: CloudEventFootprintShape,
  sourceAreaM2: number,
  chart: CloudEventTangentChart,
  footprintGrid: CloudFootprintGrid,
): CloudMassParcel {
  requireFinite(massKgM2, 'massKgM2');
  if (massKgM2 < 0) throw new RangeError('massKgM2 must be non-negative');
  const massKg = massKgM2 * sourceAreaM2;
  requireFinite(massKg, 'massKg');
  const ellipse = footprintEllipseAtBasis(
    footprintShape, chart.eastUnitVector, chart.northUnitVector);
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

// イベントの surrogate kg/m² に明示 source area を掛け、材料ごとの明示 footprint 形状で局所格子へ置く。
export function depositCloudEventMaterialCohorts(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  chart: CloudEventTangentChart,
  footprintGrid: CloudFootprintGrid,
  massGrid: CloudMassGrid,
): CloudMassDeposition {
  validateChart(chart);
  validateLocalGrid(footprintGrid, massGrid);
  const { parcels, touchedCellIndices } = cloudEventMaterialParcels(
    material, sourceAreaM2, footprintShapes,
    (phase, massKgM2, directionUnitVector, geometricHeightM, footprintShape) =>
      makeParcel(
        phase, massKgM2, directionUnitVector, geometricHeightM, footprintShape,
        sourceAreaM2, chart, footprintGrid));

  const deposition = depositCloudParcelMass(parcels, massGrid);
  validateDepositedMassBalance(
    expectedMaterialMassByPhaseKg(material, sourceAreaM2),
    depositedMassKgByPhase(deposition, massGrid, touchedCellIndices),
  );
  return deposition;
}
